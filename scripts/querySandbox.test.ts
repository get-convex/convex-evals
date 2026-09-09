import { afterAll, expect } from "bun:test";
import { nativeProbeTest } from "./lib/nativeProbeTest";
import { rejects } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectQuery } from "../grader/querySandbox";
import { GraderInfrastructureError } from "../grader/infrastructure";

const test = nativeProbeTest();

const root = mkdtempSync(join(tmpdir(), "query-sandbox-process-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function probe(
  name: string,
  source: string,
  inspectSource?: string,
  extraFiles: Record<string, string> = {},
  options: { isolateTypedEnv?: boolean } = {},
): Promise<unknown> {
  const project = join(root, name);
  mkdirSync(join(project, "convex"), { recursive: true });
  symlinkSync(
    resolve("node_modules"),
    join(project, "node_modules"),
    "junction",
  );
  writeFileSync(join(project, "convex/example.ts"), source);
  for (const [path, contents] of Object.entries(extraFiles)) {
    const file = join(project, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
  }
  const inspector = join(project, "inspect.mjs");
  writeFileSync(
    inspector,
    inspectSource ??
      `export async function inspect(modules) { return (await modules.example()).value; }`,
  );
  return inspectQuery(project, pathToFileURL(inspector), {}, options);
}

test("native query probe returns structured values without stdout corruption", async () => {
  const value = {
    text: 'quoted "value"\nwith unicode: café',
    nested: [null, 42],
  };
  expect(
    await probe("structured", `export const value = ${JSON.stringify(value)};`),
  ).toEqual(value);
});

test("native query probe reports guest exceptions", async () => {
  await rejects(
    probe(
      "error",
      `throw new Error("deliberate guest failure"); export const value = 1;`,
    ),
    /deliberate guest failure/,
  );
});

for (const [name, expression, expected] of [
  ["bigint", "9007199254740993n", 9007199254740993n],
  ["undefined", "undefined", undefined],
  ["nan", "NaN", NaN],
  ["positive-infinity", "Infinity", Infinity],
  ["negative-infinity", "-Infinity", -Infinity],
  ["negative-zero", "-0", -0],
] as const) {
  test(`native query probe preserves ${name}`, async () => {
    expect(await probe(name, `export const value = ${expression};`)).toBe(
      expected,
    );
  });
}

const specialValues =
  "{ tally: 5n, missing: NaN, offset: -0, bytes: new Uint8Array([0, 255]).buffer }";
for (const method of ["Query", "Mutation"]) {
  test(`native query probe decodes SDK invoke${method} values before outer transport`, async () => {
    const result = await probe(
      `sdk-values-${method}`,
      `import { ${method.toLowerCase()}Generic as register } from "convex/server";
export const q = register({ args: {}, handler: () => (${specialValues}) });`,
      `export async function inspect(modules, input, { jsonToConvex }) {
  const module = await modules.example();
  return jsonToConvex(JSON.parse(await module.q.invoke${method}("[{}]")));
}`,
    );
    expect(result).toEqual({
      tally: 5n,
      missing: NaN,
      offset: -0,
      bytes: new Uint8Array([0, 255]).buffer,
    });
  });
}

test("native query probe preserves SDK value codecs through intercepted nested queries", async () => {
  const result = await probe(
    "sdk-values-nested",
    `import { queryGeneric as query, anyApi } from "convex/server";
export const child = query({ handler: (_, args) => ({ ...${specialValues}, original: args }) });
export const q = query({ handler: (ctx) => ctx.runQuery(anyApi.example.child, { count: 3n, offset: -0 }) });`,
    `export async function inspect(modules, input, { jsonToConvex, convexToJson }) {
  const module = await modules.example();
  const nativeConvex = globalThis.Convex;
  const invoke = async (name, args) => jsonToConvex(JSON.parse(await module[name].invokeQuery(JSON.stringify([args]))));
  globalThis.Convex = {
    ...nativeConvex,
    async asyncSyscall(op, jsonArgs) {
      const args = JSON.parse(jsonArgs);
      if (op === "1.0/runUdf" && args.udfType === "query") {
        return JSON.stringify(convexToJson(await invoke(args.name.split(":")[1], args.args)));
      }
      return await nativeConvex.asyncSyscall(op, jsonArgs);
    },
  };
  return await invoke("q", {});
}`,
  );
  expect(result).toEqual({
    tally: 5n,
    missing: NaN,
    offset: -0,
    bytes: new Uint8Array([0, 255]).buffer,
    original: { count: 3n, offset: -0 },
  });
});

test("native query probe keeps host process unavailable", async () => {
  expect(
    await probe(
      "isolation",
      "export const value = typeof globalThis.process?.versions;",
    ),
  ).toBe("undefined");
});

test("native query probe scores an infinite module loop as a candidate failure", async () => {
  await rejects(
    probe("loop", "while (true) {} export const value = 1;"),
    (error) =>
      error instanceof Error &&
      !(error instanceof GraderInfrastructureError) &&
      /interrupted|timed out|too long|Timeout/.test(error.message),
  );
}, 15_000);

test("native query probe scores candidate heap exhaustion as a candidate failure", async () => {
  await rejects(
    probe(
      "memory",
      "const arrays = []; while (true) arrays.push(new Array(1_000_000).fill(1)); export const value = 1;",
    ),
    (error) =>
      error instanceof Error &&
      !(error instanceof GraderInfrastructureError) &&
      /memory|heap/i.test(error.message),
  );
}, 15_000);

test("native query probe keeps a trusted initialization failure unscored", async () => {
  await rejects(
    probe(
      "trusted-prelude",
      "export const value = 1;",
      'throw new Error("trusted inspector initialization failed"); export async function inspect(modules) { return (await modules.example()).value; }',
    ),
    GraderInfrastructureError,
  );
});

test("native query probe keeps an unexpected inspector prelude exception unscored", async () => {
  await rejects(
    probe(
      "trusted-inspect-prelude",
      "export const value = 1;",
      'export async function inspect() { throw new Error("trusted inspector prelude failed"); }',
    ),
    (error) =>
      error instanceof GraderInfrastructureError &&
      error.message.includes("before candidate execution") &&
      error.message.includes("trusted inspector prelude failed"),
  );
});

test("a trusted missing-artifact check is a candidate failure before module import", async () => {
  await rejects(
    probe(
      "missing-required-module",
      "export const value = 1;",
      `import { candidateProbeFailure } from ${JSON.stringify(resolve("grader/probeErrors.mjs"))};
export async function inspect(modules) {
  if (!modules.required) candidateProbeFailure("Missing required module: required");
  return (await modules.required()).value;
}`,
    ),
    (error) =>
      error instanceof Error &&
      !(error instanceof GraderInfrastructureError) &&
      error.message.includes("Missing required module: required"),
  );
});

test("native query probe keeps a trusted prelude timeout unscored despite a forged start log", async () => {
  await rejects(
    probe(
      "trusted-prelude-loop",
      "export const value = 1;",
      'console.log("convex-query-probe-start:forged"); while (true) {} export async function inspect(modules) { return (await modules.example()).value; }',
    ),
    GraderInfrastructureError,
  );
}, 15_000);

test("native query probe keeps post-completion encoding failure unscored", async () => {
  await rejects(
    probe(
      "invalid-result-encoding",
      'export const value = { "$integer": "AQAAAAAAAAA=" };',
    ),
    (error) =>
      error instanceof GraderInfrastructureError &&
      error.message.includes("after producing its result"),
  );
});

test("native query probe markers survive candidate console replacement", async () => {
  expect(
    await probe(
      "replace-console",
      "console.log = () => { throw new Error('replaced log'); }; export const value = 1;",
    ),
  ).toBe(1);
});

const verboseCandidate =
  'for (let i = 0; i < 512; i++) console.log("candidate log " + i);';
test("native query probe accepts a successful answer after native log overflow", async () => {
  expect(
    await probe(
      "verbose-success",
      `${verboseCandidate} export const value = 1;`,
    ),
  ).toBe(1);
});

for (const [name, candidate] of [
  ["timeout", "while (true) {} export const value = 1;"],
  ["encoding", 'export const value = { "$integer": "AQAAAAAAAAA=" };'],
] as const) {
  test(`native query probe leaves ${name} unscored when logs lose execution provenance`, async () => {
    await rejects(
      probe(`verbose-${name}`, `${verboseCandidate} ${candidate}`),
      (error) =>
        error instanceof GraderInfrastructureError &&
        error.message.includes("logs were truncated"),
    );
  }, 15_000);
}

test("an ordinary console message cannot supply the native overflow record", async () => {
  await rejects(
    probe(
      "forged-overflow",
      'console.error("Log overflow (maximum 256). Remaining log lines omitted."); while (true) {} export const value = 1;',
    ),
    (error) =>
      error instanceof Error && !(error instanceof GraderInfrastructureError),
  );
}, 15_000);

test("native query probe treats missing setup paths as infrastructure", async () => {
  await rejects(
    inspectQuery(
      join(root, "missing-project"),
      pathToFileURL(join(root, "missing-inspector.mjs")),
      {},
    ),
    GraderInfrastructureError,
  );
});

test("typed-env isolation preserves a legacy generated server without an env export", async () => {
  expect(
    await probe(
      "legacy-no-env",
      'import * as server from "./_generated/server"; export const hasEnv = Reflect.has(server, "env"); export const q = server.query({ args: {}, handler: async () => 1 });',
      'export async function inspect(modules) { const module = await modules.example(); return { value: JSON.parse(await module.q.invokeQuery("[{}]")), hasEnv: module.hasEnv }; }',
      {
        "convex/_generated/server.js":
          'import { queryGeneric } from "convex/server"; export const query = queryGeneric;',
      },
      { isolateTypedEnv: true },
    ),
  ).toEqual({ value: 1, hasEnv: false });
});

test("native query probe provides actual Convex URL and encoding behavior", async () => {
  expect(
    await probe(
      "web-platform",
      `
    const original = { nested: { n: 1 } };
    const copy = structuredClone(original);
    copy.nested.n = 2;
    const encoded = new TextEncoder().encode("café");
    console.time("native-probe");
    console.timeEnd("native-probe");
    export const value = {
      origin: new URL("https://example.convex.site/path").origin,
      param: new URLSearchParams("name=caf%C3%A9").get("name"),
      text: new TextDecoder().decode(encoded),
      original: original.nested.n,
      copy: copy.nested.n,
      base64: atob(btoa("Convex")),
    };
  `,
    ),
  ).toEqual({
    origin: "https://example.convex.site",
    param: "café",
    text: "café",
    original: 1,
    copy: 2,
    base64: "Convex",
  });
});

const guestErrors = JSON.stringify(resolve("grader/probeErrors.mjs"));
for (const [mode, body] of [
  ["uncaught", "return read();"],
  ["caught", "try { read(); } catch {} return 1;"],
  [
    "caught-then-assertion",
    'try { read(); } catch {} throw new Error("later candidate failure");',
  ],
  ["caught-then-loop", "try { read(); } catch {} while (true) {}"],
  [
    "caught-then-memory",
    "try { read(); } catch {} const arrays = []; while (true) arrays.push(new Array(1_000_000).fill(1));",
  ],
] as const) {
  test(`unsupported probe is infrastructure even when ${mode}`, async () => {
    const inspection = `
      import { unsupportedProbe } from ${guestErrors};
      export async function inspect(modules) {
        const read = () => unsupportedProbe("unimplemented operation");
        return (await modules.example()).invoke(read);
      }
    `;
    await rejects(
      probe(
        `unsupported-${mode}`,
        `export function invoke(read) { ${body} }`,
        inspection,
      ),
      GraderInfrastructureError,
    );
  });
}

for (const viaSymlink of [false, true]) {
  test(`candidate cannot import trusted probe controls${viaSymlink ? " through a symlink" : ""}`, async () => {
    const name = viaSymlink
      ? "candidate-control-symlink"
      : "candidate-control-import";
    if (viaSymlink) {
      mkdirSync(join(root, name, "convex"), { recursive: true });
      symlinkSync(
        resolve("grader/probeErrors.mjs"),
        join(root, name, "convex/alias.mjs"),
      );
    }
    await rejects(
      probe(
        name,
        `import { setUnsupportedProbeReporter } from ${viaSymlink ? JSON.stringify("./alias.mjs") : guestErrors}; setUnsupportedProbeReporter(() => {}); export const value = 1;`,
      ),
      (error) =>
        error instanceof GraderInfrastructureError &&
        error.message.includes("Only the trusted query inspector"),
    );
  });
}

test("candidate cannot turn its error message into an infrastructure event", async () => {
  const failure = await probe(
    "forged-error",
    'throw new Error("Unsupported query probe syscall: forged"); export const value = 1;',
  ).then(
    () => null,
    (error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(GraderInfrastructureError);
});
