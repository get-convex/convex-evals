import { beforeEach, expect, test } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { anyApi } from "convex/server";
import ts from "typescript";

const CATEGORY = "001-data_modeling";
const EVAL_NAME = "016-schema_document_validator";

type Shape = {
  _id: string;
  _creationTime: number;
  kind: "rect" | "circle" | "text";
  boardId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  text?: string;
};

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["shapes", "boards"]);
});

/** Seed one board and one shape of each kind, returning them as stored. */
async function seed(): Promise<{
  boardId: string;
  rect: Shape;
  circle: Shape;
  text: Shape;
}> {
  await addDocuments(responseAdminClient, "boards", [{ name: "Sprint board" }]);
  const boards = (await listTable(responseAdminClient, "boards", 5)) as {
    _id: string;
  }[];
  const boardId = boards[0]._id;
  await addDocuments(responseAdminClient, "shapes", [
    { kind: "rect", boardId, x: 10, y: 20, width: 30, height: 40 },
    { kind: "circle", boardId, x: 50, y: 60, radius: 7 },
    { kind: "text", boardId, x: 1, y: 2, text: "hello" },
  ]);
  const shapes = (await listTable(responseAdminClient, "shapes", 10)) as Shape[];
  const byKind = (kind: Shape["kind"]) => {
    const found = shapes.find((s) => s.kind === kind);
    if (!found) throw new Error(`seed: no ${kind} shape stored`);
    return found;
  };
  return {
    boardId,
    rect: byKind("rect"),
    circle: byKind("circle"),
    text: byKind("text"),
  };
}

async function getShape(shapeId: string): Promise<Shape | null> {
  return (await responseClient.query(anyApi.shapes.getShape, {
    shapeId,
  })) as Shape | null;
}

async function restore(snapshot: unknown): Promise<unknown> {
  return await responseClient.mutation(anyApi.shapes.restoreShape, {
    snapshot,
  });
}

/** Assert restoreShape rejects the payload at the argument validator itself. */
async function expectArgumentRejection(label: string, snapshot: unknown) {
  let error: unknown = null;
  try {
    await restore(snapshot);
  } catch (e) {
    error = e;
  }
  expect(error, `${label}: restoreShape must reject this snapshot`).not.toBeNull();
  expect(
    String(error),
    `${label}: the rejection must come from the snapshot argument validator, not from a later db error`,
  ).toContain("ArgumentValidationError");
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("restoreShape's snapshot validator is the whole-document union with system fields on every member", async () => {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as { identifier: string; args?: unknown }[];
  const entry = spec.find((f) => f.identifier === "shapes.js:restoreShape");
  expect(entry, "restoreShape must exist in convex/shapes.ts").toBeDefined();
  let args = entry!.args as any;
  if (typeof args === "string") args = JSON.parse(args);
  expect(args?.type, "restoreShape args must be an object validator").toBe(
    "object",
  );
  const snapshot = args.value?.snapshot;
  expect(snapshot, "restoreShape must take a `snapshot` argument").toBeDefined();
  expect(snapshot.optional).toBe(false);
  const union = snapshot.fieldType;
  expect(
    union?.type,
    "snapshot must be validated as the shapes document union, not v.any()/a loose object",
  ).toBe("union");
  const members = union.value as { type: string; value: Record<string, any> }[];
  expect(members).toHaveLength(3);
  const kinds = new Set<string>();
  for (const member of members) {
    expect(member.type).toBe("object");
    expect(
      member.value._id,
      "every union member must carry the _id system field",
    ).toEqual({
      fieldType: { type: "id", tableName: "shapes" },
      optional: false,
    });
    expect(
      member.value._creationTime,
      "every union member must carry the _creationTime system field",
    ).toEqual({ fieldType: { type: "number" }, optional: false });
    kinds.add(member.value.kind?.fieldType?.value);
  }
  expect([...kinds].sort()).toEqual(["circle", "rect", "text"]);
});

test("getShape returns stored documents and null for missing shapes", async () => {
  const { rect, boardId } = await seed();
  const fetched = await getShape(rect._id);
  expect(fetched).toEqual({
    _id: rect._id,
    _creationTime: rect._creationTime,
    kind: "rect",
    boardId,
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });

  await deleteAllDocuments(responseAdminClient, ["shapes"]);
  expect(await getShape(rect._id)).toBeNull();
});

test("restoreShape overwrites the shape with a genuine snapshot", async () => {
  const { rect } = await seed();
  // The client fetched this document earlier; undo sends it back with the
  // width it had at the time.
  const snapshot = await getShape(rect._id);
  expect(snapshot).not.toBeNull();

  const result = await restore({ ...snapshot, width: 300, x: -4 });
  expect(result).toBeNull();
  const after = await getShape(rect._id);
  expect(after).toEqual({ ...snapshot, width: 300, x: -4 });
  expect(after!._creationTime).toBe(rect._creationTime);
});

test("restoreShape accepts a snapshot of a different kind for the same _id", async () => {
  const { rect, boardId } = await seed();
  await restore({
    _id: rect._id,
    _creationTime: rect._creationTime,
    kind: "circle",
    boardId,
    x: 5,
    y: 6,
    radius: 12,
  });
  const after = await getShape(rect._id);
  expect(after).toEqual({
    _id: rect._id,
    _creationTime: rect._creationTime,
    kind: "circle",
    boardId,
    x: 5,
    y: 6,
    radius: 12,
  });
});

test("restoreShape rejects anything that is not a complete shapes document", async () => {
  const { rect, circle, boardId } = await seed();
  const rectSnapshot = (await getShape(rect._id))!;

  const { _creationTime: _dropped, ...withoutCreationTime } = rectSnapshot;
  await expectArgumentRejection("missing _creationTime", withoutCreationTime);

  await expectArgumentRejection("extra field", {
    ...rectSnapshot,
    color: "red",
  });

  await expectArgumentRejection("_id from another table", {
    ...rectSnapshot,
    _id: boardId,
  });

  await expectArgumentRejection("wrong field type", {
    ...rectSnapshot,
    width: "30",
  });

  const { height: _height, ...withoutHeight } = rectSnapshot;
  await expectArgumentRejection("missing member field", withoutHeight);

  await expectArgumentRejection("member fields from the wrong kind", {
    ...rectSnapshot,
    kind: "circle",
  });

  await expectArgumentRejection("_creationTime with the wrong type", {
    ...rectSnapshot,
    _creationTime: String(rectSnapshot._creationTime),
  });

  // A well-formed snapshot for a shape that has since been deleted still
  // passes validation but must be rejected by the handler.
  const circleSnapshot = (await getShape(circle._id))!;
  await deleteAllDocuments(responseAdminClient, ["shapes"]);
  await expect(restore(circleSnapshot)).rejects.toThrow();
});

test("the snapshot validator is derived from the schema, not written by hand", () => {
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const sources = collectSources(convexDir);
  expect(sources.length, "no convex sources found").toBeGreaterThan(0);
  const bindings = collectBindings(sources);

  const restoreBinding = (bindings.get("restoreShape") ?? []).find(
    (b): b is ConstBinding => b.kind === "const",
  );
  expect(restoreBinding, "restoreShape must be a top-level const").toBeDefined();
  const snapshotExpr = findSnapshotArgExpression(restoreBinding!.init, bindings);
  expect(
    snapshotExpr,
    "restoreShape must declare `args: { snapshot: ... }`",
  ).not.toBeNull();

  const derivation = describeDerivation(snapshotExpr!, bindings, new Set());
  expect(
    derivation,
    "the snapshot validator must be derived from the schema's shapes table (a whole-document validator), not a hand-written or duplicated v.object/v.union",
  ).not.toBeNull();

  // Cheat-killer: no hand-written system-field validators anywhere in the
  // authored sources (destructuring `_creationTime` out of the snapshot is a
  // binding pattern, not a property assignment, and stays allowed).
  const handWritten: string[] = [];
  for (const file of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        (node.name.text === "_creationTime" || node.name.text === "_id") &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText().startsWith("v.")
      ) {
        handWritten.push(`${file.fileName}: ${node.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(
    handWritten,
    "system-field validators must not be written by hand; derive the document validator from the schema",
  ).toEqual([]);
});

// ── helpers ──────────────────────────────────────────────────────────

type ImportBinding = {
  kind: "import";
  specifier: string;
  /** "default", "*" for namespace imports, or the exported name. */
  importedName: string;
};
type ConstBinding = { kind: "const"; init: ts.Expression; file: string };
type Binding = ImportBinding | ConstBinding;
type Bindings = Map<string, Binding[]>;
/** Pseudo-name under which each file's `export default <expr>` is recorded. */
const DEFAULT_EXPORT = "\u0000default";

function collectSources(convexDir: string): ts.SourceFile[] {
  const files: ts.SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(
          ts.createSourceFile(
            relative(convexDir, full),
            readFileSync(full, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          ),
        );
      }
    }
  };
  walk(convexDir);
  return files;
}

/** Every top-level-ish const initializer and import binding across the project, by local name. */
function collectBindings(sources: ts.SourceFile[]): Bindings {
  const bindings: Bindings = new Map();
  const add = (name: string, binding: Binding) => {
    const list = bindings.get(name) ?? [];
    list.push(binding);
    bindings.set(name, list);
  };
  for (const file of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        add(node.name.text, {
          kind: "const",
          init: node.initializer,
          file: file.fileName,
        });
      }
      // `export default defineSchema({...})` is an ExportAssignment, not a
      // variable; record it so the schema's table registrations are visible.
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        add(DEFAULT_EXPORT, {
          kind: "const",
          init: node.expression,
          file: file.fileName,
        });
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.importClause !== undefined
      ) {
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (clause.name !== undefined) {
          add(clause.name.text, {
            kind: "import",
            specifier,
            importedName: "default",
          });
        }
        const named = clause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) {
          add(named.name.text, { kind: "import", specifier, importedName: "*" });
        }
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            add(element.name.text, {
              kind: "import",
              specifier,
              importedName: (element.propertyName ?? element.name).text,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return bindings;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return property.name;
    }
  }
  return null;
}

const isSchemaSpecifier = (specifier: string) =>
  /(^|\/)schema(\.js|\.ts)?$/.test(specifier);

const isStringArg = (arg: ts.Expression | undefined, value: string) =>
  arg !== undefined &&
  (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
  arg.text === value;

/** Resolve a local identifier to its const initializer(s), following import aliases by name. */
function constInits(
  name: string,
  bindings: Bindings,
  seen: Set<string>,
): ts.Expression[] {
  if (seen.has(`const:${name}`)) return [];
  seen.add(`const:${name}`);
  const inits: ts.Expression[] = [];
  for (const binding of bindings.get(name) ?? []) {
    if (binding.kind === "const") inits.push(binding.init);
    else if (
      binding.kind === "import" &&
      binding.importedName !== "default" &&
      binding.importedName !== "*" &&
      binding.importedName !== name
    ) {
      inits.push(...constInits(binding.importedName, bindings, seen));
    }
  }
  return inits;
}

/** True when the expression is the app schema: the default export of convex/schema.ts, or a defineSchema(...) value. */
function isSchemaValue(
  expression: ts.Expression,
  bindings: Bindings,
  seen: Set<string>,
): boolean {
  const expr = unwrap(expression);
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    return (
      (ts.isIdentifier(callee) && callee.text === "defineSchema") ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "defineSchema")
    );
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "default" &&
    ts.isIdentifier(expr.expression)
  ) {
    return (bindings.get(expr.expression.text) ?? []).some(
      (b) =>
        b.kind === "import" &&
        b.importedName === "*" &&
        isSchemaSpecifier(b.specifier),
    );
  }
  if (!ts.isIdentifier(expr)) return false;
  for (const binding of bindings.get(expr.text) ?? []) {
    if (
      binding.kind === "import" &&
      binding.importedName === "default" &&
      isSchemaSpecifier(binding.specifier)
    ) {
      return true;
    }
  }
  return constInits(expr.text, bindings, seen).some((init) =>
    isSchemaValue(init, bindings, seen),
  );
}

/** The identifier the schema's defineSchema literal uses for the `shapes` table, if it is not inline. */
function schemaShapesTableName(bindings: Bindings): string | null {
  for (const list of bindings.values()) {
    for (const binding of list) {
      if (binding.kind !== "const") continue;
      const init = unwrap(binding.init);
      if (!ts.isCallExpression(init) || init.arguments.length === 0) continue;
      const callee = init.expression;
      const isDefineSchema =
        (ts.isIdentifier(callee) && callee.text === "defineSchema") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "defineSchema");
      if (!isDefineSchema) continue;
      const tables = unwrap(init.arguments[0]);
      if (!ts.isObjectLiteralExpression(tables)) continue;
      const shapes = propertyNamed(tables, "shapes");
      if (shapes !== null && ts.isIdentifier(unwrap(shapes))) {
        return (unwrap(shapes) as ts.Identifier).text;
      }
    }
  }
  return null;
}

/** True when the expression is the schema's own shapes TableDefinition (not a duplicate). */
function isShapesTableValue(
  expression: ts.Expression,
  bindings: Bindings,
  seen: Set<string>,
): boolean {
  const expr = unwrap(expression);
  // schema.tables.shapes / schema.tables["shapes"]
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "shapes" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "tables"
  ) {
    return isSchemaValue(expr.expression.expression, bindings, seen);
  }
  if (
    ts.isElementAccessExpression(expr) &&
    isStringArg(expr.argumentExpression, "shapes") &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "tables"
  ) {
    return isSchemaValue(expr.expression.expression, bindings, seen);
  }
  // A named table definition that the schema itself registers under `shapes`.
  if (ts.isIdentifier(expr)) {
    const registered = schemaShapesTableName(bindings);
    if (registered === null) return false;
    const resolvesToRegistered = (name: string): boolean => {
      if (name === registered) return true;
      return (bindings.get(name) ?? []).some(
        (b) =>
          b.kind === "import" &&
          b.importedName !== "default" &&
          b.importedName !== "*" &&
          b.importedName === registered,
      );
    };
    if (!resolvesToRegistered(expr.text)) return false;
    return constInits(expr.text, bindings, seen).some((init) =>
      isDefineTableChain(init),
    );
  }
  return false;
}

/** Whether a local callee name is bound to `exportedName` imported from `specifier`. */
function isImportedAs(
  name: string,
  bindings: Bindings,
  specifier: RegExp,
  exportedName: string,
): boolean {
  return (bindings.get(name) ?? []).some(
    (b) =>
      b.kind === "import" &&
      specifier.test(b.specifier) &&
      b.importedName === exportedName,
  );
}

/** True for `defineTable(...)`, optionally followed by `.index(...)`/`.searchIndex(...)`/`.vectorIndex(...)` chains. */
function isDefineTableChain(expression: ts.Expression): boolean {
  let current: ts.Expression = unwrap(expression);
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isIdentifier(callee)) return callee.text === "defineTable";
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === "defineTable") return true;
      current = unwrap(callee.expression);
      continue;
    }
    return false;
  }
  return false;
}

/** Locate the `snapshot` validator expression consumed by `mutation({ args: ... })`. */
function findSnapshotArgExpression(
  registration: ts.Expression,
  bindings: Bindings,
): ts.Expression | null {
  const call = unwrap(registration);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) return null;
  let config = unwrap(call.arguments[0]);
  if (ts.isIdentifier(config)) {
    const inits = constInits(config.text, bindings, new Set());
    if (inits.length === 0) return null;
    config = unwrap(inits[0]);
  }
  if (!ts.isObjectLiteralExpression(config)) return null;
  const argsExpr = propertyNamed(config, "args");
  if (argsExpr === null) return null;
  const argsObject = resolveArgsObject(argsExpr, bindings, new Set());
  if (argsObject === null) return null;
  return propertyNamed(argsObject, "snapshot");
}

/** Resolve `args` to its property-validator object literal: `{...}`, `v.object({...})`, `x.fields`, or a named const of those. */
function resolveArgsObject(
  expression: ts.Expression,
  bindings: Bindings,
  seen: Set<string>,
): ts.ObjectLiteralExpression | null {
  const expr = unwrap(expression);
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) {
    for (const init of constInits(expr.text, bindings, seen)) {
      const resolved = resolveArgsObject(init, bindings, seen);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "object" &&
    expr.arguments.length > 0
  ) {
    return resolveArgsObject(expr.arguments[0], bindings, seen);
  }
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "fields") {
    return resolveArgsObject(expr.expression, bindings, seen);
  }
  return null;
}

/**
 * Follow the consumed expression through consts/imports/wrappers until it
 * reaches a whole-document validator derived from the schema's shapes table:
 *   - `<schema>.doc("shapes")`                    (SchemaDefinition.doc, Convex 1.44)
 *   - `docValidator("shapes", <schema's shapes table>)` (convex/server, Convex 1.44)
 *   - `doc(<schema>, "shapes")`                   (convex-helpers/validators)
 * Returns a short description, or null when the chain roots elsewhere.
 */
function describeDerivation(
  expression: ts.Expression,
  bindings: Bindings,
  seen: Set<string>,
): string | null {
  const expr = unwrap(expression);
  if (ts.isIdentifier(expr)) {
    for (const init of constInits(expr.text, bindings, seen)) {
      const found = describeDerivation(init, bindings, seen);
      if (found !== null) return found;
    }
    return null;
  }
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  const [firstArg, secondArg] = expr.arguments;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "doc" &&
    isStringArg(firstArg, "shapes") &&
    isSchemaValue(callee.expression, bindings, seen)
  ) {
    return `${callee.expression.getText()}.doc("shapes")`;
  }
  if (
    ts.isIdentifier(callee) &&
    isImportedAs(callee.text, bindings, /^convex\/server$/, "docValidator") &&
    isStringArg(firstArg, "shapes") &&
    secondArg !== undefined &&
    isShapesTableValue(secondArg, bindings, seen)
  ) {
    return `docValidator("shapes", <schema shapes table>)`;
  }
  if (
    ts.isIdentifier(callee) &&
    isImportedAs(callee.text, bindings, /^convex-helpers\/validators$/, "doc") &&
    firstArg !== undefined &&
    isSchemaValue(firstArg, bindings, seen) &&
    isStringArg(secondArg, "shapes")
  ) {
    return `doc(schema, "shapes")`;
  }
  return null;
}
