import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareSchema,
  deleteAllDocuments,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { Doc } from "./answer/convex/_generated/dataModel";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { inspectTimeWindowQuery } from "./checks";

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["items"]);
});

/**
 * The task requires a caller-supplied timestamp but leaves its name open.
 * Discover the declared numeric argument and use it for every behavioral test.
 */
async function getTimeArgName(): Promise<string> {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as any[];
  const entry = spec.find((f: any) => f.identifier === "index.js:listActive");
  expect(entry, "listActive is not defined in convex/index.ts").toBeDefined();
  expect(entry.functionType).toBe("Query");
  expect(entry.visibility?.kind).toBe("public");

  let args = entry.args;
  if (typeof args === "string") {
    args = JSON.parse(args);
  }
  expect(args?.type, "listActive must declare an arguments object").toBe(
    "object",
  );
  const fields = Object.entries(args.value ?? {}) as [string, any][];
  const numericFields = fields.filter(([, field]) =>
    ["number", "float64"].includes(field?.fieldType?.type),
  );
  expect(
    numericFields,
    "listActive must take exactly one caller-supplied numeric (timestamp) argument",
  ).toHaveLength(1);
  const otherRequired = fields.filter(
    ([name, field]) => name !== numericFields[0][0] && !field?.optional,
  );
  expect(
    otherRequired,
    "listActive must not require arguments beyond its timestamp",
  ).toHaveLength(0);
  return numericFields[0][0];
}

async function listActive(now: number): Promise<Doc<"items">[]> {
  const argName = await getTimeArgName();
  return (await responseClient.query(anyApi.index.listActive, {
    [argName]: now,
  })) as Doc<"items">[];
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("declares a caller-supplied timestamp argument", async () => {
  const argName = await getTimeArgName();
  expect(argName).toBeTruthy();
});

test("strict boundary: only items expiring after the supplied time, soonest first", async () => {
  // Inserted deliberately out of expiration order.
  await addDocuments(responseAdminClient, "items", [
    { name: "later", expiresAt: NOW + 2000 },
    { name: "past", expiresAt: NOW - 5000 },
    { name: "soon", expiresAt: NOW + 1000 },
    { name: "boundary", expiresAt: NOW },
  ]);

  const results = await listActive(NOW);

  // "boundary" (expiresAt === now) is excluded: strictly greater only.
  expect(results.map((r) => r.name)).toEqual(["soon", "later"]);
});

test("the cutoff really comes from the argument", async () => {
  // Same seed, different supplied times must produce different windows - an
  // implementation that ignores its argument cannot pass all three.
  await addDocuments(responseAdminClient, "items", [
    { name: "later", expiresAt: NOW + 2000 },
    { name: "past", expiresAt: NOW - 5000 },
    { name: "soon", expiresAt: NOW + 1000 },
  ]);

  const midWindow = await listActive(NOW + 1500);
  expect(midWindow.map((r) => r.name)).toEqual(["later"]);

  const wideWindow = await listActive(NOW - 6000);
  expect(wideWindow.map((r) => r.name)).toEqual(["past", "soon", "later"]);

  const emptyWindow = await listActive(NOW + 3000);
  expect(emptyWindow).toEqual([]);
});

test("returns at most 100 items, the soonest-expiring ones", async () => {
  const items = Array.from({ length: 105 }, (_, i) => ({
    name: `item-${i + 1}`,
    expiresAt: NOW + (i + 1) * 10,
  }));
  await addDocuments(responseAdminClient, "items", items);
  const seeded = (await listTable(
    responseAdminClient,
    "items",
    200,
  )) as Doc<"items">[];
  expect(seeded).toHaveLength(105);

  const results = await listActive(NOW);

  expect(results).toHaveLength(100);
  expect(results.map((r) => r.name)).toEqual(
    Array.from({ length: 100 }, (_, i) => `item-${i + 1}`),
  );
  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1].expiresAt).toBeLessThanOrEqual(results[i].expiresAt);
  }
});

test("returns an empty array when everything has expired", async () => {
  await addDocuments(responseAdminClient, "items", [
    { name: "old-1", expiresAt: NOW - 1000 },
    { name: "old-2", expiresAt: NOW - 2000 },
  ]);

  const results = await listActive(NOW);

  expect(results).toEqual([]);
});

test(
  "listActive handles empty, partial, and full results without reading the wall clock",
  { timeout: 15_000 },
  async () => {
    const timeArgName = await getTimeArgName();
    await addDocuments(
      responseAdminClient,
      "items",
      Array.from({ length: 105 }, (_, i) => ({
        name: `item-${i + 1}`,
        expiresAt: NOW + (i + 1) * 10,
      })),
    );
    for (const cutoff of [NOW, NOW + 1025, NOW + 1050]) {
      await inspectTimeWindowQuery(
        getLatestOutputProjectDir("002-queries", "024-time_window_argument"),
        timeArgName,
        cutoff,
      );
    }
  },
);
