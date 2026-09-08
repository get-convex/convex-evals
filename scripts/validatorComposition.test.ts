import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertValidator,
  expectedShapes,
  inspectValidators,
} from "../evals/001-data_modeling/015-validator_composition/checks";

const evalDir = resolve("evals/001-data_modeling/015-validator_composition");
const reference = readFileSync(join(evalDir, "answer/validators.ts"), "utf8");
const projectDir = mkdtempSync(join(tmpdir(), "validator-composition-"));
// The runner lockfile installs the same Convex 1.44.0 SDK as the task. Reuse
// that installation so these regression tests do not need network access.
symlinkSync(
  resolve("node_modules"),
  join(projectDir, "node_modules"),
  "junction",
);
const referenceManifest = readFileSync(
  join(evalDir, "answer/package.json"),
  "utf8",
);
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

function grade(source: string, manifest = referenceManifest): void {
  writeFileSync(join(projectDir, "package.json"), manifest);
  writeFileSync(join(projectDir, "validators.ts"), source);
  const inspection = inspectValidators(projectDir);
  expect(inspection.typeErrors).toEqual([]);
  for (const name of Object.keys(expectedShapes) as Array<
    keyof typeof expectedShapes
  >) {
    assertValidator(inspection, name);
  }
}

const valid = {
  reference,
  "aliased import and base": reference
    .replace("import { v }", "import { v as cv }")
    .replaceAll("v.", "cv.")
    .replace(
      "export const partialProfileValidator",
      "const base = profileValidator;\nexport const partialProfileValidator",
    )
    .replaceAll("= profileValidator.", "= base."),
  "namespace import": reference.replace(
    'import { v } from "convex/values";',
    'import * as values from "convex/values";\nconst v = values.v;',
  ),
  "equivalent native selection": reference
    .replace('.pick("name")', '.omit("email", "internalNote")')
    .replace('.omit("internalNote")', '.pick("name", "email")'),
  "helper and field constants": reference
    .replace(
      "export const partialProfileValidator",
      'function optionalProfile(base: typeof profileValidator) { return base.partial(); }\nconst publicField = "name";\nexport const partialProfileValidator',
    )
    .replace("profileValidator.partial()", "optionalProfile(profileValidator)")
    .replace('.pick("name")', ".pick(publicField)"),
  "chained composition": reference.replace(
    "profileValidator.partial()",
    'profileValidator.pick("name", "email", "internalNote").partial().partial()',
  ),
  "native extension reusing optional field validators": reference.replace(
    "profileValidator.partial()",
    "profileValidator.extend({ name: v.optional(profileValidator.fields.name), email: v.optional(profileValidator.fields.email) })",
  ),
  "export aliases": reference
    .replace("export const publicProfileValidator", "const publicFields")
    .concat("\nexport { publicFields as publicProfileValidator };"),
};

const invalid = {
  "missing export": reference.replace(
    "export const publicProfileValidator",
    "const publicProfileValidator",
  ),
  "changed base type": reference.replace(
    "email: v.string()",
    "email: v.number()",
  ),
  "changed base optionality": reference.replace(
    "internalNote: v.optional(v.string())",
    "internalNote: v.string()",
  ),
  "required update fields": reference.replace(
    "profileValidator.partial()",
    "profileValidator",
  ),
  "nullable is not optional": reference.replace(
    "profileValidator.partial()",
    "profileValidator.extend({ name: v.union(v.string(), v.null()), email: v.union(v.string(), v.null()) })",
  ),
  "optional object is not optional fields": reference.replace(
    "profileValidator.partial()",
    "v.optional(profileValidator.partial())",
  ),
  "private fields retained": reference.replace(
    'profileValidator.pick("name")',
    "profileValidator",
  ),
  "wrong public field": reference.replace('.pick("name")', '.pick("email")'),
  "input field lost": reference.replace(
    '.omit("internalNote")',
    '.omit("internalNote", "email")',
  ),
  "input fields made optional": reference.replace(
    '.omit("internalNote")',
    '.omit("internalNote").partial()',
  ),
  "extension optional": reference.replace(
    "externalId: v.string()",
    "externalId: v.optional(v.string())",
  ),
  "extension wrong type": reference.replace(
    "externalId: v.string()",
    "externalId: v.number()",
  ),
  "extension absent": reference.replace("externalId: v.string(),", ""),
  "extra extension field": reference.replace(
    "externalId: v.string(),",
    "externalId: v.string(), extra: v.string(),",
  ),
  "unused correct call and rebuilt output": reference
    .replace(
      "export const publicProfileValidator",
      'profileValidator.pick("name");\nexport const publicProfileValidator',
    )
    .replace(
      '= profileValidator.pick("name")',
      "= v.object({ name: v.string() })",
    ),
  "rebuilt output from existing fields": reference.replace(
    'profileValidator.pick("name")',
    "v.object({ name: profileValidator.fields.name })",
  ),
  "derivation from independent identical base": reference.replace(
    'profileValidator.pick("name")',
    'v.object({ name: v.string(), email: v.string(), internalNote: v.optional(v.string()) }).pick("name")',
  ),
  "field recreated inside native chain": reference.replace(
    'profileValidator.pick("name")',
    'profileValidator.omit("name", "email", "internalNote").extend({ name: v.string() })',
  ),
  "base mutation": reference.concat(
    "\n(profileValidator.fields as any).name = v.number();",
  ),
  "derived mutation": reference.concat(
    "\n(publicProfileValidator.fields as any).name = v.string();",
  ),
  "invalid native call": reference.replace('.pick("name")', '.pick("missing")'),
  "infinite loop": reference.concat("\nwhile (true) {}"),
};

describe("validator composition grading contract", () => {
  test("accepts the exact SDK pin in devDependencies", () => {
    grade(reference, JSON.stringify({ devDependencies: { convex: "1.44.0" } }));
  });

  test("rejects a version range even when the installed SDK happens to match", () => {
    expect(() =>
      grade(reference, JSON.stringify({ dependencies: { convex: "^1.44.0" } })),
    ).toThrow("must pin convex");
  });

  for (const [name, source] of Object.entries(valid)) {
    test(`accepts ${name}`, () => grade(source), 25_000);
  }
  for (const [name, source] of Object.entries(invalid)) {
    test(
      `rejects ${name}`,
      () => expect(() => grade(source)).toThrow(),
      25_000,
    );
  }
});
