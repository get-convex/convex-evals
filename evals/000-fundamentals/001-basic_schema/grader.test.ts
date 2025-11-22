import { expect, test } from "vitest";
import { compareSchema, compareFunctionSpec } from "../../../grader";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});
