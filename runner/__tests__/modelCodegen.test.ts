import { describe, it, expect } from "bun:test";
import type { LanguageModelUsage } from "ai";
import {
  computeCostFromUsageAndPricing,
  normalizeUsageForScoring,
  parseMarkdownResponse,
  renderPrompt,
} from "../models/modelCodegen.js";

describe("parseMarkdownResponse", () => {
  it("extracts files from a well-formed markdown response", () => {
    const response = `
# Files

## package.json

\`\`\`json
{
  "name": "test",
  "dependencies": {}
}
\`\`\`

## convex/schema.ts

\`\`\`typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    text: v.string(),
  }),
});
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(Object.keys(files)).toHaveLength(2);
    expect(files["package.json"]).toContain('"name": "test"');
    expect(files["convex/schema.ts"]).toContain("defineSchema");
  });

  it("ignores content before the # Files heading", () => {
    const response = `
# Analysis

This is some analysis text.

## Component Design

Some design notes.

# Files

## convex/tasks.ts

\`\`\`typescript
export const list = query({ args: {}, handler: async (ctx) => ctx.db.query("tasks").collect() });
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(Object.keys(files)).toHaveLength(1);
    expect(files["convex/tasks.ts"]).toBeDefined();
  });

  it("returns empty object for response with no Files section", () => {
    const response = `
# Analysis

This is just analysis without any files section.
`;

    const files = parseMarkdownResponse(response);
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("returns empty object for empty response", () => {
    const files = parseMarkdownResponse("");
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("handles multiple files in correct order", () => {
    const response = `
# Files

## package.json

\`\`\`
{ "name": "app" }
\`\`\`

## tsconfig.json

\`\`\`
{ "compilerOptions": {} }
\`\`\`

## convex/schema.ts

\`\`\`
export default {};
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    const keys = Object.keys(files);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("package.json");
    expect(keys).toContain("tsconfig.json");
    expect(keys).toContain("convex/schema.ts");
  });

  it("handles code blocks with language specifiers", () => {
    const response = `
# Files

## convex/tasks.ts

\`\`\`typescript
const x = 1;
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(files["convex/tasks.ts"]).toBe("const x = 1;");
  });

  it("trims file content", () => {
    const response = `
# Files

## test.ts

\`\`\`

  const x = 1;

\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(files["test.ts"]).toBe("const x = 1;");
  });

  it("handles file paths with deep nesting", () => {
    const response = `
# Files

## convex/features/auth/helpers.ts

\`\`\`typescript
export function verify() { return true; }
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(files["convex/features/auth/helpers.ts"]).toContain("verify");
  });

  it("overwrites duplicate file names (last wins)", () => {
    const response = `
# Files

## convex/tasks.ts

\`\`\`
const v1 = "first";
\`\`\`

## convex/tasks.ts

\`\`\`
const v2 = "second";
\`\`\`
`;

    const files = parseMarkdownResponse(response);
    expect(files["convex/tasks.ts"]).toContain("second");
  });
});

describe("renderPrompt", () => {
  it("includes task description in backtick block", () => {
    const prompt = renderPrompt("Build a todo app");
    expect(prompt).toContain("Build a todo app");
    expect(prompt).toContain("```");
  });

  it("includes the Files section format guide", () => {
    const prompt = renderPrompt("test");
    expect(prompt).toContain("# Files");
    expect(prompt).toContain("## package.json");
  });

  it("does not include analysis instructions", () => {
    const prompt = renderPrompt("test");
    expect(prompt).not.toContain("Before writing any code, analyze the task");
    expect(prompt).not.toContain("Begin your response with your thought process");
    expect(prompt).not.toContain("Summarize the task requirements");
  });

  it("includes general coding standards", () => {
    const prompt = renderPrompt("test");
    expect(prompt).toContain("General Coding Standards");
    expect(prompt).toContain("2 spaces");
  });

  it("includes file structure guidance", () => {
    const prompt = renderPrompt("test");
    expect(prompt).toContain("File Structure");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("tsconfig.json");
    expect(prompt).toContain("convex/");
  });

  it("includes Convex version requirement", () => {
    const prompt = renderPrompt("test");
    expect(prompt).toContain("1.31.2");
  });

  it("always generates non-empty output", () => {
    const prompt = renderPrompt("");
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe("normalizeUsageForScoring", () => {
  const makeUsage = (
    raw: NonNullable<LanguageModelUsage["raw"]>,
  ): LanguageModelUsage => ({
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: 0,
    raw,
  });

  it("preserves usage when raw.cost already exists", () => {
    const usage = makeUsage({ cost: 0.1234 });
    const normalized = normalizeUsageForScoring(usage);
    expect(normalized?.raw).toEqual({ cost: 0.1234 });
  });

  it("extracts cost from usage.total_cost", () => {
    const usage = makeUsage({
      usage: {
        total_cost: 0.42,
      },
    });
    const normalized = normalizeUsageForScoring(usage);
    expect(normalized?.raw).toEqual({
      usage: { total_cost: 0.42 },
      cost: 0.42,
    });
  });

  it("extracts cost from provider metadata", () => {
    const usage = makeUsage({
      providerMetadata: {
        openrouter: {
          cost: "0.77",
        },
      },
    });
    const normalized = normalizeUsageForScoring(usage);
    expect(normalized?.raw).toEqual({
      providerMetadata: { openrouter: { cost: "0.77" } },
      cost: 0.77,
    });
  });

  it("leaves usage unchanged when no numeric cost is present", () => {
    const usage = makeUsage({
      usage: {
        total_cost: "unknown",
      },
    });
    const normalized = normalizeUsageForScoring(usage);
    expect(normalized).toEqual(usage);
    expect((normalized?.raw as Record<string, unknown>).cost).toBeUndefined();
  });
});

describe("computeCostFromUsageAndPricing", () => {
  it("computes cost using prompt and completion pricing", () => {
    const usage: LanguageModelUsage = {
      inputTokens: 1000,
      inputTokenDetails: {
        noCacheTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 500,
      outputTokenDetails: {
        textTokens: 500,
        reasoningTokens: 0,
      },
      totalTokens: 1500,
    };
    const cost = computeCostFromUsageAndPricing(usage, {
      prompt: 0.000001,
      completion: 0.000002,
      inputCacheRead: 0.0000001,
    });
    expect(cost).toBeCloseTo(0.002);
  });

  it("uses cache-read pricing for cached input tokens", () => {
    const usage: LanguageModelUsage = {
      inputTokens: 1000,
      inputTokenDetails: {
        noCacheTokens: 200,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      },
      outputTokens: 100,
      outputTokenDetails: {
        textTokens: 100,
        reasoningTokens: 0,
      },
      totalTokens: 1100,
    };
    const cost = computeCostFromUsageAndPricing(usage, {
      prompt: 0.000002,
      completion: 0.000004,
      inputCacheRead: 0.0000005,
    });
    expect(cost).toBeCloseTo(0.0012);
  });

  it("returns null when required token counts are missing", () => {
    const usage: LanguageModelUsage = {
      inputTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 100,
      outputTokenDetails: {
        textTokens: 100,
        reasoningTokens: 0,
      },
      totalTokens: 100,
    };
    const cost = computeCostFromUsageAndPricing(usage, {
      prompt: 0.000001,
      completion: 0.000002,
      inputCacheRead: 0.0000001,
    });
    expect(cost).toBeNull();
  });
});
