import { expect, test } from "vitest";
import { anyApi } from "convex/server";
import {
  compareFunctionSpec,
  responseAdminClient,
  readOutputFile,
  responseClient,
} from "../../../grader";

const CATEGORY = "007-components";
const EVAL_NAME = "022-action_cache";

test("public action contract", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("pins and mounts Action Cache", () => {
  const pkg = JSON.parse(readOutputFile(CATEGORY, EVAL_NAME, "package.json"));
  expect(pkg.dependencies.convex).toBe("1.41.0");
  expect(pkg.dependencies["@convex-dev/action-cache"]).toBe("0.3.1");
  const config = readOutputFile(CATEGORY, EVAL_NAME, "convex/convex.config.ts");
  expect(config).toContain("@convex-dev/action-cache/convex.config");
  expect(config).toMatch(/\.use\s*\(/);
});

type Description = { text: string; generationId: string };
const fetchDescription = async (
  productId: string,
  language: string,
  maxAgeMs?: number,
): Promise<Description> => {
  const result = await responseClient.action(anyApi.index.getDescription, {
    productId,
    language,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  });
  expect(result).toEqual({
    text: `${productId}:${language}`,
    generationId: expect.any(String),
  });
  expect(result.generationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  return result as Description;
};

test("persistent cache keys include both product and language, not TTL", async () => {
  const id = crypto.randomUUID();
  const first = await fetchDescription(id, "en");
  expect(await fetchDescription(id, "en")).toEqual(first);
  expect(await fetchDescription(id, "en", 3_600_000)).toEqual(first);
  const french = await fetchDescription(id, "fr");
  const other = await fetchDescription(`${id}-other`, "en");
  expect(new Set([first, french, other].map((r) => r.generationId)).size).toBe(
    3,
  );
  expect(await fetchDescription(id, "fr")).toEqual(french);
  expect(await fetchDescription(`${id}-other`, "en")).toEqual(other);
  expect(await fetchDescription(id, "en")).toEqual(first);
});

test("zero TTL expires an existing entry and is not part of its key", async () => {
  const id = crypto.randomUUID();
  const initial = await fetchDescription(id, "en");
  const forced = await fetchDescription(id, "en", 0);
  expect(forced.generationId).not.toBe(initial.generationId);
  // A zero-TTL entry stays expired even when the next caller uses default TTL.
  const refreshed = await fetchDescription(id, "en");
  expect(refreshed.generationId).not.toBe(initial.generationId);
  expect(refreshed.generationId).not.toBe(forced.generationId);
  expect(await fetchDescription(id, "en")).toEqual(refreshed);
});

// Inspect persisted component metadata rather than waiting on wall-clock expiry:
// query caching can delay observing Date.now() until the query is invalidated.
// Zero-TTL behavior above exercises the actual expiration path deterministically.
test("component stores the result and exact default/override TTL", async () => {
  const components = (await responseAdminClient.query(
    anyApi._system.frontend.components.list,
    {},
  )) as { id: string; path: string }[];
  const component = components.find((c) => c.path === "actionCache");
  expect(component, "Action Cache must be mounted").toBeDefined();
  const id = crypto.randomUUID();
  const first = await fetchDescription(id, "en");
  const short = await fetchDescription(id, "fr", 60_000);
  const values = (await responseAdminClient.query(
    anyApi._system.frontend.listTableScan.default,
    {
      componentId: component!.id,
      table: "values",
      limit: 100,
    },
  )) as {
    _id: string;
    args: { productId: string; language: string };
    value: Description;
    metadataId: string;
  }[];
  const metadata = (await responseAdminClient.query(
    anyApi._system.frontend.listTableScan.default,
    {
      componentId: component!.id,
      table: "metadata",
      limit: 100,
    },
  )) as { _id: string; _creationTime: number; expiresAt: number }[];
  for (const [language, expected, ttl] of [
    ["en", first, 3_600_000],
    ["fr", short, 60_000],
  ] as const) {
    const row = values.find(
      (r) => r.args.productId === id && r.args.language === language,
    );
    expect(
      row,
      "returned value must actually be persisted in Action Cache",
    ).toBeDefined();
    expect(row!.args).toEqual({ productId: id, language });
    expect(row!.value).toEqual(expected);
    const expiry = metadata.find((r) => r._id === row!.metadataId);
    expect(expiry).toBeDefined();
    // Metadata and expiration are created in the same component transaction.
    expect(
      Math.abs(expiry!.expiresAt - expiry!._creationTime - ttl),
    ).toBeLessThan(2);
  }
});
