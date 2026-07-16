import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  readOutputFile,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // The task dictates the public surface; return validators are optional and
  // internal helpers (if any) are the model's business.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

// One stateful scenario: clearing the scores table via the admin helper
// would desynchronize the component-owned aggregate, so all behavior is
// exercised in a single ordered flow instead.
test(
  "counts and ranks stay correct through inserts, ties, and updates",
  { timeout: 30_000 },
  async () => {
    const submit = (userId: string, score: number) =>
      responseClient.mutation(anyApi.index.submitScore, { userId, score });
    const rankOf = (userId: string) =>
      responseClient.query(anyApi.index.getRank, { userId });
    const count = () => responseClient.query(anyApi.index.getCount, {});

    // Empty leaderboard.
    expect(await count()).toBe(0);
    expect(await rankOf("nobody")).toBeNull();

    // Two tied leaders and one trailing user: ranks 1, 1, 3.
    const aliceId = await submit("alice", 100);
    expect(aliceId).toBeDefined();
    await submit("bob", 100);
    const carolFirstId = await submit("carol", 50);

    expect(await count()).toBe(3);
    expect(await rankOf("alice")).toBe(1);
    expect(await rankOf("bob")).toBe(1);
    expect(await rankOf("carol")).toBe(3);
    expect(await rankOf("dave")).toBeNull();

    // Updating a returning user replaces their score: same document, the
    // count must not change, and ranks must reflect the new ordering.
    const carolSecondId = await submit("carol", 125);
    expect(carolSecondId).toBe(carolFirstId);

    expect(await count()).toBe(3);
    expect(await rankOf("carol")).toBe(1);
    expect(await rankOf("alice")).toBe(2);
    expect(await rankOf("bob")).toBe(2);

    // Downgrade back below the tie and re-check - catches aggregates that
    // were inserted twice instead of replaced.
    await submit("carol", 10);
    expect(await count()).toBe(3);
    expect(await rankOf("carol")).toBe(3);
    expect(await rankOf("alice")).toBe(1);
    expect(await rankOf("bob")).toBe(1);
  },
);

test("generated solution installs and mounts the aggregate component", () => {
  const packageJson = JSON.parse(
    readOutputFile("007-components", "000-aggregate_leaderboard", "package.json"),
  );
  expect(packageJson.dependencies["@convex-dev/aggregate"]).toBe("0.2.2");
  expect(packageJson.dependencies["convex"]).toBe("1.41.0");

  const config = readOutputFile(
    "007-components",
    "000-aggregate_leaderboard",
    "convex/convex.config.ts",
  );
  expect(config).toMatch(/@convex-dev\/aggregate\/convex\.config/);
  expect(config).toMatch(/\.use\(/);
});

test("generated solution uses TableAggregate and never scans the table", () => {
  const source = readOutputFile(
    "007-components",
    "000-aggregate_leaderboard",
    "convex/index.ts",
  );
  // The component must actually be wired up, not just installed: the class
  // is constructed and synchronized on both the insert and the replace path.
  expect(source).toMatch(/TableAggregate/);
  expect(source).toMatch(/\.insert\(/);
  expect(source).toMatch(/\.replace\(|\.replaceOrInsert\(/);
  // Counting or ranking by scanning the table defeats the point.
  expect(source).not.toMatch(/\.collect\(/);
});
