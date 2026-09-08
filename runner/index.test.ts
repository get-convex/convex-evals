import { describe, expect, it } from "bun:test";
import { rejects } from "node:assert/strict";
import { buildEvalResult, runEvalsForModel } from "./index.js";

describe("experiment validation before starting a run", () => {
  it("rejects a missing OpenRouter key before starting any model or reporting work", async () => {
    const previousReporting = process.env.DISABLE_CONVEX_REPORTING;
    const previousKey = process.env.OPENROUTER_API_KEY;
    delete process.env.DISABLE_CONVEX_REPORTING;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await rejects(
        runEvalsForModel({
          experiment: "no_guidelines_with_web",
          get model(): never {
            throw new Error("Run started before validation");
          },
          tempdir: "unused",
        }),
        /requires OPENROUTER_API_KEY/,
      );
    } finally {
      if (previousReporting === undefined)
        delete process.env.DISABLE_CONVEX_REPORTING;
      else process.env.DISABLE_CONVEX_REPORTING = previousReporting;
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it.each(["EVALS_NATIVE_HARNESS", "EVALS_NATIVE_WEB_SEARCH"])(
    "rejects the retired %s setting before starting work",
    async (key) => {
      const previous = process.env[key];
      process.env[key] = key === "EVALS_NATIVE_HARNESS" ? "claude" : "true";
      try {
        await rejects(
          runEvalsForModel({
            experiment: "no_guidelines",
            get model(): never {
              throw new Error("The retired native command started a run");
            },
            tempdir: "unused",
          }),
          /Native harness experiments have been removed/,
        );
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    },
  );

  it.each([
    ["web_search", "Unsupported EVALS_EXPERIMENT"],
    ["web_search_no_guidelines", "Unsupported EVALS_EXPERIMENT"],
  ])(
    "rejects %s before accessing the model or reporting results",
    async (experiment, message) => {
      await rejects(
        runEvalsForModel({
          experiment,
          // Accessing the model marks the start of work. Keep this test unable to
          // make model or reporting calls even if validation regresses.
          get model(): never {
            throw new Error("The run started before validating its experiment");
          },
          tempdir: "unused",
        }),
        new RegExp(message),
      );
    },
  );
});

describe("buildEvalResult", () => {
  it("fails eval when eslint fails even if tests pass", () => {
    const result = buildEvalResult(
      "000-fundamentals",
      "002-basic_http_endpoint",
      "test-model",
      [
        { name: "Valid filesystem output", score: 1 },
        { name: "`bun install` succeeds", score: 1 },
        { name: "`convex dev` succeeds", score: 1 },
        { name: "Passes tsc", score: 1 },
        { name: "Passes eslint", score: 0 },
        { name: "Tests pass", score: 1 },
      ],
      "C:/tmp/convex-evals",
    );

    expect(result.tests_pass_score).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toBe("eslint fail");
  });

  it("passes eval only when all scores are perfect", () => {
    const result = buildEvalResult(
      "000-fundamentals",
      "000-empty_functions",
      "test-model",
      [
        { name: "Valid filesystem output", score: 1 },
        { name: "`bun install` succeeds", score: 1 },
        { name: "`convex dev` succeeds", score: 1 },
        { name: "Passes tsc", score: 1 },
        { name: "Passes eslint", score: 1 },
        { name: "Tests pass", score: 1 },
      ],
      "C:/tmp/convex-evals",
    );

    expect(result.passed).toBe(true);
    expect(result.failure_reason).toBeNull();
    expect(result.tests_pass_score).toBe(1);
  });

  it("fails eval on partial test score", () => {
    const result = buildEvalResult(
      "002-queries",
      "015-pagination",
      "test-model",
      [
        { name: "Valid filesystem output", score: 1 },
        { name: "`bun install` succeeds", score: 1 },
        { name: "`convex dev` succeeds", score: 1 },
        { name: "Passes tsc", score: 1 },
        { name: "Passes eslint", score: 1 },
        { name: "Tests pass", score: 0.5 },
      ],
      "C:/tmp/convex-evals",
    );

    expect(result.passed).toBe(false);
    expect(result.failure_reason).toBe("tests fail");
    expect(result.tests_pass_score).toBe(0.5);
  });
});
