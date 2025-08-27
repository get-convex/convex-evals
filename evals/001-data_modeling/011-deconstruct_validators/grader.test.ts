import { afterAll, expect, test } from "vitest";
import {
  responseAdminClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
} from "../../../grader";
import { resultValidator } from "./answer/convex/schema";
import { VLiteral, VObject, VString } from "convex/values";

import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

afterAll(async () => {
  await deleteAllDocuments(responseAdminClient, ["llm_calls", "api_calls"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("resultValidator is exported as the correct type", async () => {
  expect(resultValidator).toBeDefined();
  expect(resultValidator.kind).toBe("union");
  expect(resultValidator.members).toHaveLength(2);
  expect(resultValidator.members[0].kind).toBe("object");
  expect(resultValidator.members[1].kind).toBe("object");
  expect(resultValidator.members[0].fields).toHaveProperty("success");
  expect(resultValidator.members[0].fields.success.kind).toBe("literal");
  expect(resultValidator.members[1].fields).toHaveProperty("success");
  expect(resultValidator.members[1].fields.success.kind).toBe("literal");
  let [success, error] = resultValidator.members as VObject<
    { success: false; error?: string; value?: string },
    {
      success: VLiteral<false | true, "required">;
      error?: VString<string, "required">;
      value?: VString<string, "optional">;
    },
    "required",
    "success" | "error" | "value"
  >[];
  if (success.fields.success.value !== true) {
    [success, error] = [error, success];
  }
  expect(success.fields).toHaveProperty("value");
  expect(success.fields.value!.kind).toBe("string");
  expect(error.fields).toHaveProperty("error");
  expect(error.fields.error!.kind).toBe("string");
});

test("schema validates successful results correctly", async () => {
  await expect(
    addDocuments(responseAdminClient, "llm_calls", [
      {
        prompt: "What is the capital of France?",
        result: {
          success: true,
          value: "Paris",
        },
      },
    ]),
  ).resolves.toBeUndefined();

  await expect(
    addDocuments(responseAdminClient, "api_calls", [
      {
        url: "https://api.example.com/data",
        result: {
          success: true,
          value: "response data",
        },
      },
    ]),
  ).resolves.toBeUndefined();
});

test("schema validates error results correctly", async () => {
  await expect(
    addDocuments(responseAdminClient, "llm_calls", [
      {
        prompt: "Invalid prompt",
        result: {
          success: false,
          error: "Failed to process prompt",
        },
      },
    ]),
  ).resolves.toBeUndefined();

  await expect(
    addDocuments(responseAdminClient, "api_calls", [
      {
        url: "https://api.example.com/invalid",
        result: {
          success: false,
          error: "404 Not Found",
        },
      },
    ]),
  ).resolves.toBeUndefined();
});

test("schema rejects invalid result formats", async () => {
  // Missing required fields
  await expect(
    addDocuments(responseAdminClient, "llm_calls", [
      {
        prompt: "test",
        result: {
          success: true,
          // missing value field
        },
      },
    ]),
  ).rejects.toThrow();

  // Wrong field types
  await expect(
    addDocuments(responseAdminClient, "api_calls", [
      {
        url: "https://example.com",
        result: {
          success: false,
          error: 123, // should be string
        },
      },
    ]),
  ).rejects.toThrow();

  // Invalid success value
  await expect(
    addDocuments(responseAdminClient, "llm_calls", [
      {
        prompt: "test",
        result: {
          success: "yes", // should be boolean literal
          value: "test",
        },
      },
    ]),
  ).rejects.toThrow();
});
