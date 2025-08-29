import { expect, test, beforeEach } from "vitest";
import {
  responseClient,
  responseAdminClient,
  compareFunctionSpec,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});
