import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  getLatestOutputProjectDir,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
  withIdentity,
} from "../../../grader";
import { anyApi } from "convex/server";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "001-transactional_rate_limit";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

// One stateful scenario: rate-limiter state lives in the component and
// cannot be reset through the root tables, so the whole flow runs in order.
test(
  "quota is transactional, per-identity, and structured on rejection",
  { timeout: 30_000 },
  async () => {
    // Same subject, different issuers: keying on tokenIdentifier (not
    // subject alone) must keep these two users' quotas independent.
    const alice = withIdentity({
      subject: "user-1",
      issuer: "https://issuer-a.example.com",
    });
    const bob = withIdentity({
      subject: "user-1",
      issuer: "https://issuer-b.example.com",
    });

    // Unauthenticated callers are rejected.
    await expect(
      responseClient.mutation(anyApi.index.sendMessage, { body: "hello" }),
    ).rejects.toThrow();

    // A whitespace body is rejected - and must not consume quota: the two
    // valid sends below only both succeed if this consumed token rolled
    // back with the failed mutation.
    await expect(
      alice.mutation(anyApi.index.sendMessage, { body: "   " }),
    ).rejects.toThrow();

    const first = await alice.mutation(anyApi.index.sendMessage, {
      body: "first",
    });
    const second = await alice.mutation(anyApi.index.sendMessage, {
      body: "second",
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);

    // Third valid message within the window: the component's structured
    // rate-limit error, distinguishable by clients.
    let limited: unknown;
    try {
      await alice.mutation(anyApi.index.sendMessage, { body: "third" });
    } catch (error) {
      limited = error;
    }
    expect(limited, "third message within the hour must be rejected").toBeDefined();
    const data = (limited as { data?: Record<string, unknown> }).data;
    expect(data, "rejection must carry the component's structured data").toBeDefined();
    expect(data!.kind).toBe("RateLimited");
    expect(data!.name).toBe("sendMessage");
    expect(data!.retryAfter).toBeTypeOf("number");

    // A different identity with the same subject has an untouched quota
    // (kills subject-only keys), and so does one with the same issuer but a
    // different subject (kills issuer-only keys).
    const returned: Record<string, unknown> = { first, second };
    returned["bob-first"] = await bob.mutation(anyApi.index.sendMessage, {
      body: "bob-first",
    });
    returned["bob-second"] = await bob.mutation(anyApi.index.sendMessage, {
      body: "bob-second",
    });
    const carol = withIdentity({
      subject: "user-2",
      issuer: "https://issuer-a.example.com",
    });
    returned["carol-first"] = await carol.mutation(anyApi.index.sendMessage, {
      body: "carol-first",
    });
    returned["carol-second"] = await carol.mutation(anyApi.index.sendMessage, {
      body: "carol-second",
    });

    // Exactly the six successful messages exist, attributed per identity,
    // and every call returned the _id of the document it inserted.
    const messages = (await listTable(
      responseAdminClient,
      "messages",
      100,
    )) as { _id: string; authorTokenIdentifier: string; body: string }[];
    for (const message of messages) {
      const key = message.body === "first" ? "first" : message.body === "second" ? "second" : message.body;
      expect(
        returned[key],
        `sendMessage must return the inserted message ID for "${message.body}"`,
      ).toBe(message._id);
    }
    expect(messages).toHaveLength(6);
    expect(messages.map((m) => m.body).sort()).toEqual([
      "bob-first",
      "bob-second",
      "carol-first",
      "carol-second",
      "first",
      "second",
    ]);
    const authors = new Set(messages.map((m) => m.authorTokenIdentifier));
    expect(authors.size).toBe(3);
    for (const author of authors) {
      expect(author).toMatch(/user-[12]/);
    }
  },
);

test("generated solution installs and mounts the rate-limiter component", () => {
  const packageJson = JSON.parse(
    readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
  );
  expect(packageJson.dependencies["@convex-dev/rate-limiter"]).toBe("0.3.2");
  expect(packageJson.dependencies["convex"]).toBe("1.41.0");

  const config = readOutputFile(CATEGORY, EVAL_NAME, "convex/convex.config.ts");
  expect(config).toMatch(/@convex-dev\/rate-limiter\/convex\.config/);
  expect(config).toMatch(/\.use\(/);

  // The task says auth is already configured: a generated auth.config.ts
  // would overwrite the deployment's intended auth setup.
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  expect(
    existsSync(join(projectDir, "convex", "auth.config.ts")),
    "do not create convex/auth.config.ts - authentication is already configured",
  ).toBe(false);
});

test("generated solution consumes the limit before semantic validation", () => {
  // Analyze every authored convex source so limiter instances, helpers,
  // and aliases factored into other files still count.
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  const convexDir = join(projectDir, "convex");
  const sourceFiles = new Map<string, ts.SourceFile>();
  const loadSources = (relativeDir: string) => {
    for (const entry of readdirSync(join(convexDir, relativeDir), {
      withFileTypes: true,
    })) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "_generated") {
        loadSources(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readOutputFile(CATEGORY, EVAL_NAME, `convex/${relativePath}`);
      const moduleName = relativePath.replace(/\.ts$/, "");
      sourceFiles.set(
        moduleName,
        ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );
    }
  };
  loadSources("");
  expect(sourceFiles.has("index"), "create convex/index.ts").toBe(true);

  // Global collections across all authored files.
  const constDeclarations = new Map<string, ts.Expression>();
  const tokenIdentifierAliases = new Set<string>();
  const rateLimiterCtors = new Set<string>();
  const hourNames = new Set<string>();
  const timeConstants = new Map<string, number>();
  // moduleName -> set of limiter variable names declared there
  const limiterVarsByModule = new Map<string, Set<string>>();
  // moduleName -> (functionName -> body)
  const functionsByModule = new Map<string, Map<string, ts.Node>>();
  let hasFixedWindowTwoPerHour = false;

  const resolve = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    for (let i = 0; i < 5; i++) {
      if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
        current = current.expression;
      } else if (
        ts.isIdentifier(current) &&
        constDeclarations.has(current.text)
      ) {
        current = constDeclarations.get(current.text)!;
      } else {
        break;
      }
    }
    return current;
  };

  const evaluateNumeric = (
    expression: ts.Expression,
    depth = 0,
  ): number | undefined => {
    if (depth > 6) return undefined;
    const value = resolve(expression);
    if (ts.isNumericLiteral(value)) {
      return Number(value.text.replaceAll("_", ""));
    }
    if (ts.isIdentifier(value) && timeConstants.has(value.text)) {
      return timeConstants.get(value.text);
    }
    if (ts.isBinaryExpression(value)) {
      const left = evaluateNumeric(value.left, depth + 1);
      const right = evaluateNumeric(value.right, depth + 1);
      if (left === undefined || right === undefined) return undefined;
      if (value.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
      if (value.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    }
    return undefined;
  };
  const resolvesToHour = (expression: ts.Expression): boolean => {
    const value = resolve(expression);
    if (ts.isIdentifier(value) && hourNames.has(value.text)) return true;
    return evaluateNumeric(expression) === 3_600_000;
  };

  const isRateLimiterConstruction = (
    expression: ts.Expression,
  ): expression is ts.NewExpression => {
    if (!ts.isNewExpression(expression)) return false;
    const target = resolve(expression.expression);
    return ts.isIdentifier(target) && rateLimiterCtors.has(target.text);
  };

  const checkLimiterConfig = (construction: ts.NewExpression) => {
    const configArg = construction.arguments?.[1];
    if (configArg === undefined) return;
    const config = resolve(configArg);
    if (!ts.isObjectLiteralExpression(config)) return;
    for (const property of config.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
        property.name.text !== "sendMessage"
      ) {
        continue;
      }
      const definition = resolve(property.initializer);
      if (!ts.isObjectLiteralExpression(definition)) continue;
      let kindOk = false;
      let rateOk = false;
      let periodOk = false;
      for (const field of definition.properties) {
        if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name)) {
          continue;
        }
        const value = resolve(field.initializer);
        if (
          field.name.text === "kind" &&
          ts.isStringLiteralLike(value) &&
          value.text === "fixed window"
        ) {
          kindOk = true;
        }
        if (
          field.name.text === "rate" &&
          ts.isNumericLiteral(value) &&
          Number(value.text) === 2
        ) {
          rateOk = true;
        }
        if (field.name.text === "period" && resolvesToHour(field.initializer)) {
          periodOk = true;
        }
      }
      if (kindOk && rateOk && periodOk) {
        hasFixedWindowTwoPerHour = true;
      }
    }
  };

  // Pass 1: imports, const declarations, destructuring aliases, functions.
  for (const [moduleName, sourceFile] of sourceFiles) {
    functionsByModule.set(moduleName, new Map());
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@convex-dev/rate-limiter"
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            if (importedName === "RateLimiter") rateLimiterCtors.add(element.name.text);
            if (importedName === "HOUR") hourNames.add(element.name.text);
            const timeValues: Record<string, number> = {
              SECOND: 1000,
              MINUTE: 60_000,
              HOUR: 3_600_000,
              DAY: 86_400_000,
            };
            if (importedName in timeValues) {
              timeConstants.set(element.name.text, timeValues[importedName]);
            }
          }
        }
      }
    }
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        if (ts.isIdentifier(node.name)) {
          constDeclarations.set(node.name.text, node.initializer);
          if (
            ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer)
          ) {
            functionsByModule
              .get(moduleName)!
              .set(node.name.text, node.initializer.body ?? node.initializer);
          }
        }
        // const { tokenIdentifier } / { tokenIdentifier: alias } = identity
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const propertyName =
              element.propertyName !== undefined &&
              ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : ts.isIdentifier(element.name)
                  ? element.name.text
                  : undefined;
            if (propertyName === "tokenIdentifier" && ts.isIdentifier(element.name)) {
              tokenIdentifierAliases.add(element.name.text);
            }
          }
        }
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined
      ) {
        functionsByModule.get(moduleName)!.set(node.name.text, node.body);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  // Pass 2: limiter constructions and their configs, per module.
  for (const [moduleName, sourceFile] of sourceFiles) {
    const vars = new Set<string>();
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = resolve(node.initializer);
        if (isRateLimiterConstruction(initializer)) {
          vars.add(node.name.text);
          checkLimiterConfig(initializer);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    limiterVarsByModule.set(moduleName, vars);
  }

  // index.ts local-import map: localName -> { module, originalName }
  const indexFile = sourceFiles.get("index")!;
  const localImports = new Map<string, { module: string; originalName: string }>();
  for (const statement of indexFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith("./")
    ) {
      continue;
    }
    const module = statement.moduleSpecifier.text
      .replace(/^\.\//, "")
      .replace(/\.(ts|js)$/, "");
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        localImports.set(element.name.text, {
          module,
          originalName: (element.propertyName ?? element.name).text,
        });
      }
    }
  }

  const isLimiterReceiver = (expression: ts.Expression): boolean => {
    const receiver = resolve(expression);
    if (ts.isIdentifier(receiver)) {
      if (limiterVarsByModule.get("index")!.has(receiver.text)) return true;
      const imported = localImports.get(receiver.text);
      if (
        imported !== undefined &&
        limiterVarsByModule.get(imported.module)?.has(imported.originalName)
      ) {
        return true;
      }
    }
    if (isRateLimiterConstruction(receiver)) {
      checkLimiterConfig(receiver);
      return true;
    }
    return false;
  };

  const referencesTokenIdentifier = (expression: ts.Expression): boolean => {
    for (const candidate of [expression, resolve(expression)]) {
      if (
        ts.isPropertyAccessExpression(candidate) &&
        candidate.name.text === "tokenIdentifier"
      ) {
        return true;
      }
      if (
        ts.isIdentifier(candidate) &&
        (candidate.text === "tokenIdentifier" ||
          tokenIdentifierAliases.has(candidate.text))
      ) {
        return true;
      }
    }
    return false;
  };

  const resolveHelper = (name: string): ts.Node | undefined => {
    const local = functionsByModule.get("index")!.get(name);
    if (local !== undefined) return local;
    const imported = localImports.get(name);
    if (imported === undefined) return undefined;
    return functionsByModule.get(imported.module)?.get(imported.originalName);
  };

  // Locate the sendMessage handler in index.ts.
  let handlerBody: ts.Node | undefined;
  const findHandler = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "sendMessage" &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      for (const property of node.initializer.arguments[0].properties) {
        const isHandlerName =
          property.name !== undefined &&
          ts.isIdentifier(property.name) &&
          property.name.text === "handler";
        if (ts.isPropertyAssignment(property) && isHandlerName) {
          handlerBody = property.initializer;
        }
        if (ts.isMethodDeclaration(property) && isHandlerName) {
          handlerBody = property.body;
        }
      }
    }
    ts.forEachChild(node, findHandler);
  };
  findHandler(indexFile);
  expect(
    handlerBody,
    "register a public mutation sendMessage in convex/index.ts",
  ).toBeDefined();

  // Execution-order walk of the handler, inlining helpers (local or
  // imported from authored modules) so limit/validation/insert count at
  // their call sites and dead code counts nowhere.
  let limitCallPos = -1;
  let throwsTrue = false;
  let keyedOnTokenIdentifier = false;
  let trimPos = -1;
  let insertPos = -1;
  let step = 0;

  const inspectLimitCall = (node: ts.CallExpression) => {
    step++;
    if (limitCallPos !== -1) return;
    limitCallPos = step;
    const rawOptions = node.arguments[2] ?? node.arguments[1];
    const options = rawOptions === undefined ? undefined : resolve(rawOptions);
    if (options !== undefined && ts.isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isIdentifier(property.name)
        ) {
          continue;
        }
        if (
          property.name.text === "throws" &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          throwsTrue = true;
        }
        if (
          property.name.text === "key" &&
          referencesTokenIdentifier(property.initializer)
        ) {
          keyedOnTokenIdentifier = true;
        }
      }
    }
  };

  const walked = new Set<ts.Node>();
  const walk = (node: ts.Node, depth: number) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (name === "limit" && isLimiterReceiver(node.expression.expression)) {
        inspectLimitCall(node);
      }
      if (["trim", "trimStart", "trimEnd", "test", "match"].includes(name)) {
        step++;
        if (trimPos === -1) trimPos = step;
      }
      if (
        name === "insert" &&
        ((ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === "db") ||
          (ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "db"))
      ) {
        step++;
        if (insertPos === -1) insertPos = step;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      depth < 4
    ) {
      const body = resolveHelper(node.expression.text);
      if (body !== undefined && !walked.has(body)) {
        walked.add(body);
        walk(body, depth + 1);
        walked.delete(body);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const operands = [node.left, node.right];
      const emptyString = operands.some(
        (operand) => ts.isStringLiteralLike(operand) && operand.text === "",
      );
      const lengthAccess = operands.some(
        (operand) =>
          ts.isPropertyAccessExpression(operand) &&
          operand.name.text === "length",
      );
      if (emptyString || lengthAccess) {
        step++;
        if (trimPos === -1) trimPos = step;
      }
    }
    ts.forEachChild(node, (child) => walk(child, depth));
  };
  if (handlerBody !== undefined) {
    walk(handlerBody, 0);
  }

  expect(
    limitCallPos,
    "call limit() on a RateLimiter constructed from @convex-dev/rate-limiter",
  ).toBeGreaterThan(-1);
  expect(
    hasFixedWindowTwoPerHour,
    'configure sendMessage as { kind: "fixed window", rate: 2, period: HOUR }',
  ).toBe(true);
  expect(throwsTrue, "use throws: true so clients get the structured error").toBe(
    true,
  );
  expect(
    keyedOnTokenIdentifier,
    "key the limit on the caller's identity tokenIdentifier",
  ).toBe(true);
  // Behavior cannot distinguish consume-then-validate from validate-then-
  // consume (a rolled-back token and an unconsumed one look identical), so
  // the ordering the task specifies is checked structurally - and the
  // validation site must be locatable, or the ordering cannot be verified.
  expect(
    trimPos,
    "validate the body with a recognizable construct (trim/regex/empty comparison)",
  ).toBeGreaterThan(-1);
  expect(
    limitCallPos,
    "consume the rate limit before validating the message body",
  ).toBeLessThan(trimPos);
  // Rollback also hides insert-before-validation behaviorally.
  expect(
    insertPos,
    "insert the message with ctx.db.insert in the sendMessage path",
  ).toBeGreaterThan(-1);
  expect(
    trimPos,
    "insert the message only after validation succeeds",
  ).toBeLessThan(insertPos);
});
