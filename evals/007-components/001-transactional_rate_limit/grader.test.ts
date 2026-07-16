import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
  withIdentity,
} from "../../../grader";
import { anyApi } from "convex/server";
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
});

test("generated solution consumes the limit before semantic validation", () => {
  const source = readOutputFile(CATEGORY, EVAL_NAME, "convex/index.ts");
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let limitCallPos = -1;
  let throwsTrue = false;
  let keyedOnTokenIdentifier = false;
  let trimPos = -1;

  // Resolve identifiers (hoisted options objects) through const
  // declarations anywhere in the file.
  const constDeclarations = new Map<string, ts.Expression>();
  const collectDeclarations = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      constDeclarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  const resolve = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    for (let i = 0; i < 5; i++) {
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current)
      ) {
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

  // The key must reference the identity's tokenIdentifier: either a
  // property access ending in .tokenIdentifier or a destructured
  // `tokenIdentifier` identifier.
  const referencesTokenIdentifier = (expression: ts.Expression): boolean => {
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "tokenIdentifier"
    ) {
      return true;
    }
    return (
      ts.isIdentifier(expression) && expression.text === "tokenIdentifier"
    );
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (name === "limit" && limitCallPos === -1) {
        limitCallPos = node.getStart();
        const rawOptions = node.arguments[2] ?? node.arguments[1];
        const options =
          rawOptions === undefined ? undefined : resolve(rawOptions);
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
      }
      if (
        ["trim", "trimStart", "trimEnd", "test", "match"].includes(name) &&
        trimPos === -1
      ) {
        trimPos = node.getStart();
      }
    }
    // Comparisons against an empty string or zero length also mark the
    // body validation, so regex- or length-based checks anchor the
    // ordering assertion too.
    if (ts.isBinaryExpression(node) && trimPos === -1) {
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
        trimPos = node.getStart();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  expect(limitCallPos, "call the rate limiter's limit()").toBeGreaterThan(-1);
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
});
