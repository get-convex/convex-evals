import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { failGraderInfrastructure } from "../../../grader/infrastructure";

export interface Inspection {
  typeErrors: string[];
  validators: Record<
    string,
    {
      json: unknown;
      isOptional: string;
      derived: boolean;
      preservesFields: boolean;
    } | null
  >;
}

export function inspectValidators(projectDir: string): Inspection {
  const result = spawnSync(
    "node",
    [fileURLToPath(new URL("./inspect.mjs", import.meta.url)), projectDir],
    {
      // Do not give model code the runner's API keys or reporting credentials.
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1_000_000,
    },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    // Resource limits can be consumed by candidate code. Failure to start the
    // trusted Node process at all cannot establish anything about the answer.
    if (code !== "ETIMEDOUT" && code !== "ENOBUFS")
      failGraderInfrastructure(
        `Could not start validator inspection: ${String(result.error)}`,
        "validator_process",
      );
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Validator module failed: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as Inspection;
}

const stringField = (optional = false) => ({
  fieldType: { type: "string" },
  optional,
});
const object = (value: Record<string, ReturnType<typeof stringField>>) => ({
  type: "object",
  value,
});

export const expectedShapes = {
  profileValidator: object({
    name: stringField(),
    email: stringField(),
    internalNote: stringField(true),
  }),
  partialProfileValidator: object({
    name: stringField(true),
    email: stringField(true),
    internalNote: stringField(true),
  }),
  publicProfileValidator: object({ name: stringField() }),
  profileInputValidator: object({ name: stringField(), email: stringField() }),
  identifiedProfileValidator: object({
    name: stringField(),
    email: stringField(),
    internalNote: stringField(true),
    externalId: stringField(),
  }),
};

export function assertValidator(
  inspection: Inspection,
  name: keyof typeof expectedShapes,
): void {
  const validator = inspection.validators[name];
  assert(validator, `Missing object validator: ${name}`);
  assert.equal(
    validator.isOptional,
    "required",
    `${name}: the object must be required`,
  );
  assert.deepEqual(
    validator.json,
    expectedShapes[name],
    `${name}: wrong validator shape`,
  );
  if (name !== "profileValidator") {
    assert(
      validator.derived,
      `${name}: must derive from the exported base using native composition`,
    );
    assert(
      validator.preservesFields,
      `${name}: must reuse the original field validators`,
    );
  }
}
