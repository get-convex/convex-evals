import { describe, expect, it, vi } from "vitest";
import { getTextOutputEvalIncompatibilityReason } from "../runner/models/openRouterDiscovery.js";
import {
  isOpenRouterFreeVariant,
  selectTopModels as selectTopOpenRouterModels,
  shouldSkipForProviderError,
  shouldSkipForMissingEndpoint,
} from "./listTopOpenRouterModels.js";
import {
  buildPeriodicMatrix,
  mergeModelSources,
  selectTopWeeklyCandidates,
} from "./listPeriodicModels.js";

describe("top OpenRouter selector helpers", () => {
  it("deduplicates while preserving ranking order", () => {
    expect(
      selectTopOpenRouterModels(["a", "b", "a", "c", "d"], 3),
    ).toEqual(["a", "b", "c"]);
  });

  it("skips provider 400 preflight failures", () => {
    expect(
      shouldSkipForProviderError(
        new Error("400 Bad Request: Provider returned error"),
      ),
    ).toBe(true);
  });

  it("skips missing-endpoint preflight failures", () => {
    expect(
      shouldSkipForMissingEndpoint(
        new Error("404 Not Found: No endpoints found for foo/bar."),
      ),
    ).toBe(true);
  });

  it("does not treat unrelated errors as keepable or skippable", () => {
    const error = new Error("500 Internal Server Error");
    expect(shouldSkipForProviderError(error)).toBe(false);
    expect(shouldSkipForMissingEndpoint(error)).toBe(false);
  });
});

describe("OpenRouter capability helpers", () => {
  it("allows multimodal input when output is text-only", () => {
    expect(
      getTextOutputEvalIncompatibilityReason({
        inputModalities: ["text", "image", "file"],
        outputModalities: ["text"],
      }),
    ).toBeNull();
  });

  it("rejects mixed output modalities", () => {
    expect(
      getTextOutputEvalIncompatibilityReason({
        inputModalities: ["text", "image"],
        outputModalities: ["text", "audio"],
      }),
    ).toBe("output modalities [text, audio] are not text-only");
  });

  it("rejects non-text output modalities", () => {
    expect(
      getTextOutputEvalIncompatibilityReason({
        inputModalities: ["text"],
        outputModalities: ["rerank"],
      }),
    ).toBe("output modalities [rerank] are not text-only");
  });

  it("rejects models whose input does not include text", () => {
    expect(
      getTextOutputEvalIncompatibilityReason({
        inputModalities: ["image", "audio"],
        outputModalities: ["text"],
      }),
    ).toBe("input modalities [image, audio] do not include text");
  });

  it("falls back to hasTextOutput when output modalities are missing", () => {
    expect(
      getTextOutputEvalIncompatibilityReason({
        hasTextOutput: false,
      }),
    ).toBe("model does not have text output");
  });
});

describe("periodic selector helpers", () => {
  it("skips rate-limited :free variants from the top-weekly source and logs each one", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        selectTopWeeklyCandidates(
          [
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "curated/model",
            "a/b",
            "poolside/laguna-s-2.1:free",
            "c/d",
            "e/f",
          ],
          2,
          new Set(["curated/model"]),
        ),
      ).toEqual(["a/b", "c/d"]);
      const lines = log.mock.calls.map((call) => String(call[0]));
      for (const slug of [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "poolside/laguna-s-2.1:free",
      ]) {
        expect(
          lines.some((line) =>
            line.includes(`[periodic] [top-weekly] skipping ${slug}: free`),
          ),
        ).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("only treats the :free suffix as a free variant", () => {
    expect(isOpenRouterFreeVariant("poolside/laguna-s-2.1:free")).toBe(true);
    expect(isOpenRouterFreeVariant("poolside/laguna-s-2.1")).toBe(false);
    expect(isOpenRouterFreeVariant("free/model")).toBe(false);
  });

  it("merges sources and deduplicates in source order", () => {
    expect(
      mergeModelSources([
        ["curated", ["a", "b"]],
        ["top-weekly", ["b", "c", "a"]],
      ]),
    ).toEqual({
      models: ["a", "b", "c"],
      modelSources: {
        a: ["curated", "top-weekly"],
        b: ["curated", "top-weekly"],
        c: ["top-weekly"],
      },
    });
  });

  it("skips only the web condition for web-excluded models", () => {
    expect(
      buildPeriodicMatrix(
        ["a", "b"],
        ["default", "no_guidelines", "no_guidelines_with_web"],
        new Set(["b"]),
      ),
    ).toEqual([
      { model: "a", experiment: "default" },
      { model: "a", experiment: "no_guidelines" },
      { model: "a", experiment: "no_guidelines_with_web" },
      { model: "b", experiment: "default" },
      { model: "b", experiment: "no_guidelines" },
    ]);
  });

  it("keeps excluded models when web is not scheduled", () => {
    expect(
      buildPeriodicMatrix(["b"], ["default", "no_guidelines"], new Set(["b"])),
    ).toEqual([
      { model: "b", experiment: "default" },
      { model: "b", experiment: "no_guidelines" },
    ]);
  });
});
