import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { inspectBoundedQuery } from "../evals/002-queries/022-unbounded_query_no_collect/checks";
import { boundedQueryFixtures } from "./lib/boundedQueryFixtures";

const projectDir = mkdtempSync(join(tmpdir(), "bounded-query-"));
cpSync(
  resolve(
    "evals/002-queries/022-unbounded_query_no_collect/answer/convex/_generated",
  ),
  join(projectDir, "convex/_generated"),
  { recursive: true },
);
symlinkSync(
  resolve("node_modules"),
  join(projectDir, "node_modules"),
  "junction",
);
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

for (const fixture of boundedQueryFixtures) {
  test(`native bounded-read probe: ${fixture.name}`, async () => {
    for (const [path, source] of Object.entries(fixture.files)) {
      const file = join(projectDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const inspect = () => inspectBoundedQuery(projectDir);
    if (fixture.bounded)
      expect((await inspect()).bounds.length).toBeGreaterThan(0);
    else await expect(inspect()).rejects.toThrow();
  });
}

function writeProbeSource(body: string, prefix = ""): void {
  writeFileSync(
    join(projectDir, "convex/index.ts"),
    `${prefix}
import { query } from "./_generated/server";
import { v } from "convex/values";
export const listAuditLogs = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    ${body}
    return await ctx.db.query("auditLogs").withIndex("by_workspaceId", q => q.eq("workspaceId", args.workspaceId)).take(25);
  },
});`,
  );
}

test("sandbox exposes no host environment, filesystem, or process globals", async () => {
  writeProbeSource(`
    for (const name of ["process", "Bun", "Deno", "require", "fetch", "WebSocket"]) {
      if (typeof globalThis[name] !== "undefined") throw new Error("Host API exposed: " + name);
    }
    if (({}).constructor.constructor("return typeof process")() !== "undefined") throw new Error("Host constructor escape");
  `);
  expect((await inspectBoundedQuery(projectDir)).bounds).toEqual([25]);
});

test("sandbox supports the generated SDK's empty environment export", async () => {
  writeProbeSource(
    'if (Object.keys(env).length !== 0) throw new Error("Host environment exposed");',
    "const env = process.env;",
  );
  expect((await inspectBoundedQuery(projectDir)).bounds).toEqual([25]);
});

test("sandbox cannot execute top-level host filesystem imports", async () => {
  const destination = join(projectDir, "must-not-be-written");
  writeProbeSource(
    "",
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(destination)}, "escaped");`,
  );
  await expect(inspectBoundedQuery(projectDir)).rejects.toThrow();
  expect(existsSync(destination)).toBe(false);
});

test("sandbox cannot spawn a host process", async () => {
  writeProbeSource(
    `const child = await import("node:child_process"); child.execFileSync("node", ["--version"]);`,
  );
  await expect(inspectBoundedQuery(projectDir)).rejects.toThrow();
});

test("sandbox cannot connect to the network", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("unexpected");
    },
  });
  try {
    writeProbeSource(`await fetch(${JSON.stringify(server.url.href)});`);
    await expect(inspectBoundedQuery(projectDir)).rejects.toThrow();
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("bundler refuses data imports outside generated sources and dependencies", async () => {
  const canary = join(projectDir, "private.json");
  writeFileSync(canary, JSON.stringify({ secret: "private-canary" }));
  writeProbeSource(
    "if (privateData.secret) throw new Error(privateData.secret);",
    `import privateData from ${JSON.stringify(canary)};`,
  );
  await expect(inspectBoundedQuery(projectDir)).rejects.toThrow(
    "outside the generated source",
  );
});

test("bundler refuses symlink escapes", async () => {
  const canary = join(projectDir, "private-module.ts");
  const link = join(projectDir, "convex/linked.ts");
  writeFileSync(canary, 'export const secret = "private-canary";');
  symlinkSync(canary, link);
  try {
    writeProbeSource(
      "if (secret) throw new Error(secret);",
      'import { secret } from "./linked";',
    );
    await expect(inspectBoundedQuery(projectDir)).rejects.toThrow(
      "outside the generated source",
    );
  } finally {
    rmSync(link);
  }
});

test("sandbox interrupts an infinite loop", async () => {
  writeProbeSource("while (true) {}");
  await expect(inspectBoundedQuery(projectDir)).rejects.toThrow(/interrupted/);
});

test("sandbox enforces its heap limit", async () => {
  writeProbeSource(
    "const arrays = []; while (true) arrays.push(new Array(1_000_000).fill(123));",
  );
  await expect(inspectBoundedQuery(projectDir)).rejects.toThrow(
    /out of memory/,
  );
  writeProbeSource("");
  expect((await inspectBoundedQuery(projectDir)).bounds).toEqual([25]);
});
