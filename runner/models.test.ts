import { describe, it, expect } from "bun:test";
import {
  ALL_MODELS,
  MODEL_NAMES,
  SYSTEM_PROMPT,
  OPENROUTER_API_KEY_VAR,
  OPENROUTER_BASE_URL,
  DEFAULT_MAX_CONCURRENCY,
  resolveModelDefaults,
} from "./models/index.js";

describe("ALL_MODELS", () => {
  it("contains at least one model", () => {
    expect(ALL_MODELS.length).toBeGreaterThan(0);
  });

  it("every entry is a non-empty string", () => {
    for (const model of ALL_MODELS) {
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(ALL_MODELS).size).toBe(ALL_MODELS.length);
  });

  it("contains known models", () => {
    expect(ALL_MODELS).toContain("openai/gpt-5.2-codex");
    expect(ALL_MODELS).toContain("openai/gpt-5");
    expect(ALL_MODELS).toContain("openai/gpt-5.5");
    expect(ALL_MODELS).toContain("anthropic/claude-opus-4.6");
    expect(ALL_MODELS).toContain("anthropic/claude-opus-4.7");
    expect(ALL_MODELS).toContain("deepseek/deepseek-v4-pro");
    expect(ALL_MODELS).toContain("moonshotai/kimi-k2.6");
    expect(ALL_MODELS).toContain("google/gemini-2.5-flash");
  });
});

describe("MODEL_NAMES", () => {
  it("has the same number of entries as ALL_MODELS", () => {
    expect(MODEL_NAMES.size).toBe(ALL_MODELS.length);
  });

  it("contains a known model", () => {
    expect(MODEL_NAMES.has("openai/gpt-5")).toBe(true);
  });

  it("returns false for non-existent model", () => {
    expect(MODEL_NAMES.has("non-existent-model")).toBe(false);
  });
});

describe("resolveModelDefaults", () => {
  it("returns all required fields", () => {
    const resolved = resolveModelDefaults("test/model");
    expect(resolved.name).toBe("test/model");
    expect(resolved.runnableName).toBe("test/model");
    expect(resolved.formattedName).toBe("test/model");
    expect(resolved.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(resolved.apiKind).toBe("chat");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(SYSTEM_PROMPT).toBeTruthy();
    expect(typeof SYSTEM_PROMPT).toBe("string");
  });

  it("mentions Convex", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("convex");
  });
});

describe("OpenRouter constants", () => {
  it("API key var is correct", () => {
    expect(OPENROUTER_API_KEY_VAR).toBe("OPENROUTER_API_KEY");
  });

  it("base URL starts with https://", () => {
    expect(OPENROUTER_BASE_URL).toMatch(/^https:\/\//);
  });

  it("default max concurrency is a positive integer", () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_CONCURRENCY)).toBe(true);
  });
});
