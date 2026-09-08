import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectNestedWriteLimit } from "../evals/005-idioms/008-nested_transaction_limits/checks";
import { nestedTransactionLimitsFixtures } from "./lib/nestedTransactionLimitsFixtures";

const root = mkdtempSync(join(tmpdir(), "nested-write-limit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const fixture of nestedTransactionLimitsFixtures) {
  test(`nested write limit execution: ${fixture.name}`, async () => {
    const projectDir = join(root, fixture.name);
    cpSync(
      resolve(
        "evals/005-idioms/008-nested_transaction_limits/answer/convex/_generated",
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
    const result = inspectNestedWriteLimit(projectDir, {
      _id: "probe-job",
      _creationTime: 1,
      name: "probe",
      status: "pending",
    });
    const outcome = await result.then(
      (value) => value.calls,
      (error: unknown) => error,
    );
    if (fixture.valid) expect(outcome).toBe(5);
    else {
      if (!(outcome instanceof Error))
        throw new Error("Expected the probe to reject this fixture");
      expect(outcome.message).toMatch(
        /No nested writeDeliveries call|Pass the original jobId and count|needs a native five-write limit/,
      );
    }
  });
}
