import { describe, expect, it } from "vitest";
import type { Id } from "../convex/types";
import { resolveModelId } from "./modelIdentifier";

describe("resolveModelId", () => {
  it("resolves a public model slug before it is used as an ID", () => {
    expect(
      resolveModelId("anthropic/claude-opus-4.7", {
        _id: "k5786msechpzmh4dpc4qt822c984y8we" as Id<"models">,
      }),
    ).toBe("k5786msechpzmh4dpc4qt822c984y8we");
  });

  it("keeps existing Convex ID routes working", () => {
    const modelId = "k5786msechpzmh4dpc4qt822c984y8we";

    expect(resolveModelId(modelId, undefined)).toBe(modelId);
  });

  it("returns null when a public slug does not exist", () => {
    expect(resolveModelId("anthropic/does-not-exist", null)).toBeNull();
  });
});
