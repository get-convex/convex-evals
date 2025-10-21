import { expect, test } from "vitest";
import { responseAdminClient, addDocuments } from "../../../grader";

test("schema enforces optional/nullable constraints", async () => {
  // Valid cases
  await expect(
    addDocuments(responseAdminClient, "optionals", [
      { nullable: null },
      { nullable: "string" },
      { nullable: "string", maybe_nullable: null },
      { nullable: "string", maybe_nullable: "string" },
      { nullable: "string", maybe: "string" },
    ]),
  ).resolves.toBeUndefined();

  // Invalid cases
  await expect(
    addDocuments(responseAdminClient, "optionals", [
      {}, // Missing required nullable field
    ]),
  ).rejects.toThrow();

  await expect(
    addDocuments(responseAdminClient, "optionals", [
      { nullable: "string", maybe: null }, // maybe cannot be null
    ]),
  ).rejects.toThrow();
});
