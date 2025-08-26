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
import { aiGradeGeneratedOutput } from "../../../grader/aiGrader";

test("AI grader assessment", { timeout: 60000 }, async () => {
  await expect(aiGradeGeneratedOutput(import.meta.url)).resolves.toBe("pass");
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});
