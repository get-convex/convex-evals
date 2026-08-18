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
  const project = loadProject(convexDir);
  expect(project.size, "no convex sources found").toBeGreaterThan(0);

  const shapesModule = project.get("shapes.ts");
  expect(shapesModule, "convex/shapes.ts must exist").toBeDefined();
  const restoreInit = shapesModule!.consts.get("restoreShape");
  expect(
    restoreInit,
    "restoreShape must be a top-level const in convex/shapes.ts",
  ).toBeDefined();
  const snapshotExpr = findSnapshotArgExpression(
    { expr: restoreInit!, file: "shapes.ts" },
    project,
  );
  expect(
    snapshotExpr,
    "restoreShape must declare `args: { snapshot: ... }`",
  ).not.toBeNull();

  const derivation = describeDerivation(snapshotExpr!, project, new Set());
  expect(
    derivation,
    "the snapshot validator must be derived from the schema's shapes table (a whole-document validator), not a hand-written or duplicated v.object/v.union",
  ).not.toBeNull();

  // Cheat-killer: no hand-written system-field validators anywhere in the
  // authored sources (destructuring `_creationTime` out of the snapshot is a
  // binding pattern, not a property assignment, and stays allowed).
  const handWritten: string[] = [];
  for (const module of project.values()) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        (node.name.text === "_creationTime" || node.name.text === "_id") &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText().startsWith("v.")
      ) {
        handWritten.push(`${module.file}: ${node.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(module.source);
  }
  expect(
    handWritten,
    "system-field validators must not be written by hand; derive the document validator from the schema",
  ).toEqual([]);
});

// ── helpers: a tiny per-module symbol resolver ────────────────────────

type ImportBinding = {
  specifier: string;
  /** "default", "*" for namespace imports, or the exported name. */
  importedName: string;
};
type Module = {
  file: string;
  source: ts.SourceFile;
  consts: Map<string, ts.Expression>;
  imports: Map<string, ImportBinding>;
  defaultExport: ts.Expression | null;
};
type Project = Map<string, Module>;
/** A located expression, or a symbol imported from an npm package. */
type Located = { expr: ts.Expression; file: string };
type Resolved = Located | { pkg: string; name: string };

function loadProject(convexDir: string): Project {
  const project: Project = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        const file = relative(convexDir, full).replace(/\\/g, "/");
        const source = ts.createSourceFile(
          file,
          readFileSync(full, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        project.set(file, indexModule(file, source));
      }
    }
  };
  walk(convexDir);
  return project;
}

function indexModule(file: string, source: ts.SourceFile): Module {
  const module: Module = {
    file,
    source,
    consts: new Map(),
    imports: new Map(),
    defaultExport: null,
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      module.consts.set(node.name.text, node.initializer);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      module.defaultExport = node.expression;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause !== undefined
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause.name !== undefined) {
        module.imports.set(clause.name.text, {
          specifier,
          importedName: "default",
        });
      }
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) {
        module.imports.set(named.name.text, { specifier, importedName: "*" });
      }
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          module.imports.set(element.name.text, {
            specifier,
            importedName: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return module;
}

/** Map a relative import specifier to a project file, or null for packages. */
function resolveSpecifier(
  specifier: string,
  fromFile: string,
  project: Project,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = fromFile.includes("/")
    ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1)
    : "";
  const parts: string[] = [];
  for (const segment of (base + specifier).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const path = parts.join("/").replace(/\.(js|ts)$/, "");
  for (const candidate of [`${path}.ts`, `${path}/index.ts`]) {
    if (project.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve a local identifier in `file` to the expression(s) it names, following imports across modules. */
function resolveName(
  name: string,
  file: string,
  project: Project,
  seen: Set<string>,
): Resolved[] {
  const key = `${file}::${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const module = project.get(file);
  if (module === undefined) return [];
  const results: Resolved[] = [];
  const local = module.consts.get(name);
  if (local !== undefined) results.push({ expr: local, file });
  const imported = module.imports.get(name);
  if (imported !== undefined) {
    const target = resolveSpecifier(imported.specifier, file, project);
    if (target === null) {
      results.push({ pkg: imported.specifier, name: imported.importedName });
    } else if (imported.importedName === "default") {
      const targetModule = project.get(target)!;
      if (targetModule.defaultExport !== null) {
        results.push(...resolveExpression(targetModule.defaultExport, target, project, seen));
      }
    } else if (imported.importedName !== "*") {
      results.push(...resolveName(imported.importedName, target, project, seen));
    }
  }
  return results;
}

/** Follow an expression through identifiers (and `ns.member` on namespace imports) until it is a concrete expression or package symbol. */
function resolveExpression(
  expression: ts.Expression,
  file: string,
  project: Project,
  seen: Set<string>,
): Resolved[] {
  const expr = unwrap(expression);
  if (ts.isIdentifier(expr)) {
    const resolved = resolveName(expr.text, file, project, seen);
    const out: Resolved[] = [];
    for (const r of resolved) {
      if ("expr" in r && ts.isIdentifier(unwrap(r.expr))) {
        out.push(...resolveExpression(r.expr, r.file, project, seen));
      } else {
        out.push(r);
      }
    }
    return out;
  }
  const namespaced = namespaceMember(expr, file, project);
  if (namespaced !== null) {
    if (namespaced.target === null) {
      return [{ pkg: namespaced.specifier, name: namespaced.member }];
    }
    if (namespaced.member === "default") {
      const targetModule = project.get(namespaced.target)!;
      return targetModule.defaultExport === null
        ? []
        : resolveExpression(targetModule.defaultExport, namespaced.target, project, seen);
    }
    return resolveName(namespaced.member, namespaced.target, project, seen);
  }
  return [{ expr, file }];
}

/** `ns.member` where `ns` is a namespace import in this module. */
function namespaceMember(
  expression: ts.Expression,
  file: string,
  project: Project,
): { specifier: string; target: string | null; member: string } | null {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression)
  ) {
    return null;
  }
  const binding = project.get(file)?.imports.get(expression.expression.text);
  if (binding === undefined || binding.importedName !== "*") return null;
  return {
    specifier: binding.specifier,
    target: resolveSpecifier(binding.specifier, file, project),
    member: expression.name.text,
  };
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

const isStringArg = (arg: ts.Expression | undefined, value: string) =>
  arg !== undefined &&
  (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
  arg.text === value;

const SCHEMA_FILE = "schema.ts";

/**
 * The schema's identity: the concrete expression `convex/schema.ts`
 * default-exports (`export default defineSchema({...})`, or the const it
 * exports by name). Any other defineSchema(...) value is a duplicate.
 */
function canonicalSchema(project: Project): Located | null {
  const module = project.get(SCHEMA_FILE);
  if (module === undefined || module.defaultExport === null) return null;
  const resolved = resolveExpression(module.defaultExport, SCHEMA_FILE, project, new Set());
  const located = resolved.find((r): r is Located => "expr" in r);
  return located ?? null;
}

/** True when the expression is the app schema (by identity of the default-exported value). */
function isSchemaValue(expression: ts.Expression, file: string, project: Project): boolean {
  const canonical = canonicalSchema(project);
  if (canonical === null) return false;
  return resolveExpression(expression, file, project, new Set()).some(
    (r) => "expr" in r && unwrap(r.expr) === unwrap(canonical.expr),
  );
}

/** The concrete TableDefinition expression the canonical schema registers under `shapes`. */
function canonicalShapesTable(project: Project): Located | null {
  const canonical = canonicalSchema(project);
  if (canonical === null) return null;
  const init = unwrap(canonical.expr);
  if (!ts.isCallExpression(init) || init.arguments.length === 0) return null;
  const tables = unwrap(init.arguments[0]);
  if (!ts.isObjectLiteralExpression(tables)) return null;
  const shapes = propertyNamed(tables, "shapes");
  if (shapes === null) return null;
  const resolved = resolveExpression(shapes, canonical.file, project, new Set());
  return resolved.find((r): r is Located => "expr" in r) ?? null;
}

/** True when the expression is the schema's own shapes TableDefinition (not a duplicate). */
function isShapesTableValue(expression: ts.Expression, file: string, project: Project): boolean {
  const expr = unwrap(expression);
  // schema.tables.shapes / schema.tables["shapes"]
  const tablesReceiver = (): ts.Expression | null => {
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "shapes" &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "tables"
    ) {
      return expr.expression.expression;
    }
    if (
      ts.isElementAccessExpression(expr) &&
      isStringArg(expr.argumentExpression, "shapes") &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "tables"
    ) {
      return expr.expression.expression;
    }
    return null;
  };
  const receiver = tablesReceiver();
  if (receiver !== null) return isSchemaValue(receiver, file, project);
  // The very table definition the schema registers (shared module or local const).
  const registered = canonicalShapesTable(project);
  if (registered === null) return false;
  return resolveExpression(expr, file, project, new Set()).some(
    (r) => "expr" in r && unwrap(r.expr) === unwrap(registered.expr),
  );
}

/** Whether a callee expression is `exportedName` from an npm `specifier` (named, aliased, or namespace import). */
function isPackageSymbol(
  callee: ts.Expression,
  file: string,
  project: Project,
  specifier: RegExp,
  exportedName: string,
): boolean {
  return resolveExpression(callee, file, project, new Set()).some(
    (r) => "pkg" in r && specifier.test(r.pkg) && r.name === exportedName,
  );
}

/** Locate the `snapshot` validator expression consumed by `mutation({ args: ... })`. */
function findSnapshotArgExpression(registration: Located, project: Project): ts.Expression | null {
  const call = unwrap(registration.expr);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) return null;
  const configs = resolveExpression(call.arguments[0], registration.file, project, new Set());
  for (const config of configs) {
    if (!("expr" in config)) continue;
    const literal = unwrap(config.expr);
    if (!ts.isObjectLiteralExpression(literal)) continue;
    const argsExpr = propertyNamed(literal, "args");
    if (argsExpr === null) continue;
    const argsObject = resolveArgsObject({ expr: argsExpr, file: config.file }, project, new Set());
    if (argsObject === null) continue;
    return propertyNamed(argsObject, "snapshot");
  }
  return null;
}

/** Resolve `args` to its property-validator object literal: `{...}`, `v.object({...})`, `x.fields`, or a const of those. */
function resolveArgsObject(
  located: Located,
  project: Project,
  seen: Set<string>,
): ts.ObjectLiteralExpression | null {
  for (const r of resolveExpression(located.expr, located.file, project, seen)) {
    if (!("expr" in r)) continue;
    const expr = unwrap(r.expr);
    if (ts.isObjectLiteralExpression(expr)) return expr;
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "object" &&
      expr.arguments.length > 0
    ) {
      const inner = resolveArgsObject({ expr: expr.arguments[0], file: r.file }, project, seen);
      if (inner !== null) return inner;
    }
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "fields") {
      const inner = resolveArgsObject({ expr: expr.expression, file: r.file }, project, seen);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Follow the consumed expression through consts/imports/wrappers until it
 * reaches a whole-document validator derived from the schema's shapes table:
 *   - `<schema>.doc("shapes")`                          (SchemaDefinition.doc, Convex 1.44)
 *   - `docValidator("shapes", <schema's shapes table>)` (convex/server, Convex 1.44)
 *   - `doc(<schema>, "shapes")`                         (convex-helpers/validators)
 * Returns a short description, or null when the chain roots elsewhere.
 */
function describeDerivation(expression: ts.Expression, project: Project, seen: Set<string>): string | null {
  // The snapshot expression lives in shapes.ts; resolution follows imports from there.
  for (const r of resolveExpression(expression, "shapes.ts", project, seen)) {
    if (!("expr" in r)) continue;
    const expr = unwrap(r.expr);
    if (!ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    const [firstArg, secondArg] = expr.arguments;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "doc" &&
      isStringArg(firstArg, "shapes") &&
      isSchemaValue(callee.expression, r.file, project)
    ) {
      return `${callee.expression.getText()}.doc("shapes")`;
    }
    if (
      isPackageSymbol(callee, r.file, project, /^convex\/server$/, "docValidator") &&
      isStringArg(firstArg, "shapes") &&
      secondArg !== undefined &&
      isShapesTableValue(secondArg, r.file, project)
    ) {
      return `docValidator("shapes", <schema shapes table>)`;
    }
    if (
      isPackageSymbol(callee, r.file, project, /^convex-helpers\/validators$/, "doc") &&
      firstArg !== undefined &&
      isSchemaValue(firstArg, r.file, project) &&
      isStringArg(secondArg, "shapes")
    ) {
      return `doc(schema, "shapes")`;
    }
  }
  return null;
}
