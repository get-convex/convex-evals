import { afterAll, expect, test } from "bun:test";
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
import { isDeepStrictEqual } from "node:util";
import {
  expectedSupportConfig,
  inspectTypedAppEnv,
  supportConfigCases,
} from "../evals/005-idioms/006-typed_env/checks";
import { typedEnvFixtures } from "./lib/typedEnvFixtures";

const root = mkdtempSync(join(tmpdir(), "typed-env-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const fixture of typedEnvFixtures) {
  test(`typed env execution: ${fixture.name}`, async () => {
    const projectDir = join(root, fixture.name);
    cpSync(
      resolve("evals/005-idioms/006-typed_env/answer/convex/_generated"),
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
      for (const env of supportConfigCases("unit")) {
        const actual = await inspectTypedAppEnv(projectDir, env);
        if (!isDeepStrictEqual(actual.result, expectedSupportConfig(env)))
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
      expect([...reads].sort()).toEqual(["DEPLOYMENT_STAGE", "SUPPORT_EMAIL"]);
    } else {
      if (!(failure instanceof Error))
        throw new Error("Expected the probe to reject this fixture");
      expect(failure.message).toMatch(
        /Returned configuration did not match|Read app variable .* through process.env/,
      );
    }
  }, 15_000);
}
