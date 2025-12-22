import { expect, test } from "vitest";
import { responseAdminClient, addDocuments, listTable } from "../../../grader";

test("example table accepts required compound datatypes", async () => {
  const idPlaceholder = "example:placeholder";
  await addDocuments(responseAdminClient, "example", [
    {
      a: { artist: 1, tags: ["rock", "pop"] },
      b: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      c: {},
      d: { k: "v" },
      e: { type: "a", value: 1 },
      f: "x",
    },
  ]);
  const rows = await listTable(responseAdminClient, "example");
  expect(rows.length).toBeGreaterThan(0);
});

test("example table rejects invalid union variants", async () => {
  await expect(
    addDocuments(responseAdminClient, "example", [
      {
        a: { artist: 1, tags: [] },
        b: [],
        c: {},
        d: {},
        e: { type: "c", value: 1 } as unknown as {
          type: "a" | "b";
          value: number | string;
        },
        f: [true],
      },
    ]),
  ).rejects.toBeDefined();
});
