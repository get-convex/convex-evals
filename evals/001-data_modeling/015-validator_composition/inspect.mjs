// Run in a fresh child process: instrumentation must never affect another eval.
// This is bounded execution with a stripped environment, not a security sandbox.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const projectDir = process.argv[2];
const filename = join(projectDir, "validators.ts");
const source = readFileSync(filename, "utf8");
const projectRequire = createRequire(join(projectDir, "package.json"));
const manifest = JSON.parse(
  readFileSync(join(projectDir, "package.json"), "utf8"),
);
const declaredVersion =
  manifest.dependencies?.convex ?? manifest.devDependencies?.convex;
if (declaredVersion !== "1.44.0") {
  throw new Error('package.json must pin convex to "1.44.0"');
}
if (projectRequire("convex/package.json").version !== "1.44.0") {
  throw new Error("Expected installed Convex 1.44.0");
}

const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};
const program = ts.createProgram([filename], options);
const typeErrors = ts
  .getPreEmitDiagnostics(program)
  .map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
if (typeErrors.length) {
  process.stdout.write(JSON.stringify({ typeErrors, validators: {} }));
  process.exit(0);
}

const values = projectRequire("convex/values");
// VObject is a type-only public export in this SDK version.
const VObject = Object.getPrototypeOf(values.v.object({})).constructor;
const parents = new WeakMap();
const optionalParents = new WeakMap();

function freezeValidator(validator) {
  if (validator instanceof VObject) {
    for (const field of Object.values(validator.fields)) freezeValidator(field);
    Object.freeze(validator.fields);
  }
  return Object.freeze(validator);
}

// Record genuine native calls and their returned identities. A disconnected
// call cannot give credit to a separately rebuilt export.
for (const method of ["partial", "pick", "omit", "extend"]) {
  const original = VObject.prototype[method];
  VObject.prototype[method] = function (...args) {
    const result = original.apply(this, args);
    parents.set(result, this);
    if (method === "partial") {
      for (const [key, field] of Object.entries(result.fields)) {
        // asOptional() can return the same validator if already optional.
        if (field !== this.fields[key]) {
          optionalParents.set(field, this.fields[key]);
        }
      }
    }
    return freezeValidator(result);
  };
}
Object.freeze(VObject.prototype);
const originalObject = values.v.object;
const originalOptional = values.v.optional;
const instrumentedValues = {
  ...values,
  v: Object.freeze({
    ...values.v,
    object: (fields) => freezeValidator(originalObject(fields)),
    optional: (validator) => {
      const result = originalOptional(validator);
      if (result !== validator) optionalParents.set(result, validator);
      return freezeValidator(result);
    },
  }),
};

const compiled = ts.transpileModule(source, {
  fileName: filename,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const exports = {};
runInNewContext(
  compiled,
  {
    exports,
    require: (specifier) => {
      if (specifier !== "convex/values") {
        throw new Error("Only imports from convex/values are allowed");
      }
      return instrumentedValues;
    },
  },
  { filename, timeout: 1000 },
);

function descendsFrom(value, ancestor, links) {
  const seen = new Set();
  for (
    let current = value;
    current && !seen.has(current);
    current = links.get(current)
  ) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

const base = exports.profileValidator;
const validators = {};
for (const name of [
  "profileValidator",
  "partialProfileValidator",
  "publicProfileValidator",
  "profileInputValidator",
  "identifiedProfileValidator",
]) {
  const validator = exports[name];
  if (!(validator instanceof VObject)) {
    validators[name] = null;
    continue;
  }
  validators[name] = {
    json: validator.json,
    isOptional: validator.isOptional,
    derived: validator !== base && descendsFrom(validator, base, parents),
    // Shape equality alone would allow dropping a field then recreating it
    // with a fresh v.string(). Existing fields must retain their provenance.
    preservesFields:
      base instanceof VObject &&
      Object.entries(validator.fields).every(
        ([key, field]) =>
          !(key in base.fields) ||
          descendsFrom(field, base.fields[key], optionalParents),
      ),
  };
}
process.stdout.write(JSON.stringify({ typeErrors, validators }));
