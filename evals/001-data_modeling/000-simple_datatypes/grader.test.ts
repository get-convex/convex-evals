import { expect, test } from "vitest";
import { responseAdminClient, addDocuments, listTable } from "../../../grader";

test("example table accepts correct simple datatypes", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  await addDocuments(responseAdminClient, "example", [
    {
      a: null,
      b: 42,
      c: 3.14,
      d: BigInt(10),
      e: BigInt(7),
      f: true,
      g: "hello",
      h: bytes,
      i: { any: "value" },
    },
  ]);
  const rows = await listTable(responseAdminClient, "example");
  expect(rows.length).toBeGreaterThan(0);
});

test("example table rejects invalid types", async () => {
  // Wrong types for a few fields should be rejected
  await expect(
    addDocuments(responseAdminClient, "example", [
      {
        // Intentionally invalid types
        a: "not-null" as unknown as null,
        b: "not-number" as unknown as number,
      },
    ]),
  ).rejects.toBeDefined();
});
