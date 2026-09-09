import { afterAll, expect } from "bun:test";
import { nativeProbeTest } from "./lib/nativeProbeTest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  expectedDeploymentInfo,
  deploymentInfoMatches,
  inspectPlatformEnv,
  platformEnvCases,
} from "../evals/005-idioms/009-platform_env_urls/checks";
import { platformEnvFixtures } from "./lib/platformEnvFixtures";

const root = mkdtempSync(join(tmpdir(), "platform-env-"));
// Native handles need a real deployed address. The stub is never used to supply
// candidate results: nested queries must execute the bundled fixture helper.
const nativeReference = join(root, "native-reference");
cpSync(
  resolve("evals/005-idioms/009-platform_env_urls/answer"),
  nativeReference,
  { recursive: true },
);
writeFileSync(
  join(nativeReference, "convex/helper.ts"),
  `import { internalQuery } from "./_generated/server";
export const readInfo = internalQuery({ args: {}, handler: async () => null });`,
);
const test = nativeProbeTest(nativeReference);
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const fixture of platformEnvFixtures) {
  test(`platform env execution: ${fixture.name}`, async () => {
    const projectDir = join(root, fixture.name);
    cpSync(
      resolve(
        "evals/005-idioms/009-platform_env_urls/answer/convex/_generated",
      ),
      join(projectDir, "convex/_generated"),
      { recursive: true },
    );
    symlinkSync(
      resolve("node_modules"),
      join(projectDir, "node_modules"),
      "junction",
    );
    for (const [path, contents] of Object.entries(fixture.files)) {
      const destination = join(projectDir, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    if (fixture.files["convex.json"]) {
      const server = join(projectDir, "convex/_generated/server.js");
      // Exercise the typed initializer emitted by codegen.fileType="ts" too.
      // The full-pipeline replay separately runs actual SDK codegen in this mode.
      const source = readFileSync(server, "utf8").replace(
        "export const env = process.env;",
        "export const env: Record<string, string | undefined> = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;",
      );
      writeFileSync(join(projectDir, "convex/_generated/server.ts"), source);
      rmSync(server);
    }
    let failure: unknown;
    const reads = new Set<string>();
    try {
      for (const env of platformEnvCases("unit")) {
        const actual = await inspectPlatformEnv(projectDir, env);
        if (fixture.valid && fixture.name.endsWith("-special-values")) {
          const extras = actual.result as unknown as Record<string, unknown>;
          expect(extras.tally).toBe(1n);
          expect(Number.isNaN(extras.notANumber)).toBe(true);
          expect(Object.is(extras.negativeZero, -0)).toBe(true);
          expect(extras.bytes).toBeInstanceOf(ArrayBuffer);
          expect([...new Uint8Array(extras.bytes as ArrayBuffer)]).toEqual([
            1, 2, 3,
          ]);
        }
        if (!deploymentInfoMatches(actual.result, expectedDeploymentInfo(env)))
          throw new Error(
            "Returned configuration did not match typed env values",
          );
        actual.reads.forEach((key) => reads.add(key));
      }
    } catch (error) {
      failure = error;
    }
    if (fixture.probeValid) {
      expect(failure).toBeUndefined();
      expect([...reads].sort()).toEqual([
        "CONVEX_CLOUD_URL",
        "CONVEX_SITE_URL",
        "PUBLIC_APP_NAME",
      ]);
    } else {
      if (!(failure instanceof Error))
        throw new Error("Expected the probe to reject this fixture");
      expect(failure.message).toMatch(
        /Missing query|useStaleSnapshot.*only supported in mutations|Returned configuration did not match|Read environment variable .* through process.env/,
      );
    }
  }, 15_000);
}
