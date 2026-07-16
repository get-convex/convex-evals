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

    // A different identity with the same subject has an untouched quota.
    await bob.mutation(anyApi.index.sendMessage, { body: "bob-first" });
    await bob.mutation(anyApi.index.sendMessage, { body: "bob-second" });

    // Exactly the four successful messages exist, attributed per identity.
    const messages = (await listTable(
      responseAdminClient,
      "messages",
      100,
    )) as { authorTokenIdentifier: string; body: string }[];
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.body).sort()).toEqual([
      "bob-first",
      "bob-second",
      "first",
      "second",
    ]);
    const authors = new Set(messages.map((m) => m.authorTokenIdentifier));
    expect(authors.size).toBe(2);
    for (const author of authors) {
      expect(author).toContain("user-1");
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
  let usesTokenIdentifier = false;
  let trimPos = -1;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (name === "limit" && limitCallPos === -1) {
        limitCallPos = node.getStart();
        const options = node.arguments[2] ?? node.arguments[1];
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "throws" &&
              property.initializer.kind === ts.SyntaxKind.TrueKeyword
            ) {
              throwsTrue = true;
            }
          }
        }
      }
      if (name === "trim" && trimPos === -1) {
        trimPos = node.getStart();
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "tokenIdentifier"
    ) {
      usesTokenIdentifier = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  expect(limitCallPos, "call the rate limiter's limit()").toBeGreaterThan(-1);
  expect(throwsTrue, "use throws: true so clients get the structured error").toBe(
    true,
  );
  expect(
    usesTokenIdentifier,
    "key the limit on the caller's identity tokenIdentifier",
  ).toBe(true);
  // Behavior cannot distinguish consume-then-validate from validate-then-
  // consume (a rolled-back token and an unconsumed one look identical), so
  // the ordering the task specifies is checked structurally.
  if (trimPos !== -1) {
    expect(
      limitCallPos,
      "consume the rate limit before validating the message body",
    ).toBeLessThan(trimPos);
  }
});
