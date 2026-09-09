import { describe, expect, it } from "vitest";
import { combineWebUsage, computeWebUsage, webUsageAverages } from "./webUsage";
import type { Doc } from "./_generated/dataModel";
const evalWith = (
  raw: Record<string, unknown>,
): Pick<Doc<"evals">, "status"> => ({
  status: { kind: "passed", durationMs: 1, usage: { raw } },
});
const zeroEvidence = {
  cost: 0.02,
  cost_details: { upstream_inference_cost: 0.02 },
  webResearch: {
    searchEngine: "exa",
    fetchEngine: "exa",
    requestAttempts: 1,
    sourceCitations: 0,
  },
};
describe("web usage coverage", () => {
  it("includes explicit and inferred zero-use evals in the denominator", () => {
    const usage = computeWebUsage([
      evalWith({
        server_tool_use_details: {
          web_search_requests: 3,
          web_fetch_requests: 2,
        },
      }),
      evalWith({
        server_tool_use_details: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
      }),
      evalWith(zeroEvidence),
    ]);
    expect(webUsageAverages(usage)).toEqual({
      averageWebSearchesPerEval: 1,
      averageWebSearchesEstimated: true,
      averageWebFetchesPerEval: null,
      webSearchTelemetryEvalCount: 2,
      webUsageEvalCount: 3,
    });
  });
  it.each([
    {},
    { ...zeroEvidence, cost: 0.03 },
    {
      ...zeroEvidence,
      webResearch: { ...zeroEvidence.webResearch, sourceCitations: 1 },
    },
    {
      ...zeroEvidence,
      webResearch: { ...zeroEvidence.webResearch, searchEngine: "native" },
    },
    { ...zeroEvidence, server_tool_use_details: { tool_calls_executed: 1 } },
    {
      ...zeroEvidence,
      webResearch: { ...zeroEvidence.webResearch, requestAttempts: 2 },
    },
  ])(
    "does not replace ambiguous or contradictory telemetry with zero: %j",
    (raw) => {
      expect(
        webUsageAverages(computeWebUsage([evalWith(raw)]))
          .averageWebSearchesPerEval,
      ).toBeNull();
    },
  );
  it("pools counts by eval, and preserves unknown legacy partitions", () => {
    const a = computeWebUsage([
      evalWith({
        server_tool_use: { web_search_requests: 4, web_fetch_requests: 2 },
      }),
    ]);
    const b = computeWebUsage([
      evalWith({
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      }),
      evalWith({
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
      }),
    ]);
    expect(webUsageAverages(combineWebUsage([a, b]))).toMatchObject({
      averageWebSearchesPerEval: 2,
      averageWebFetchesPerEval: 1,
      averageWebSearchesEstimated: false,
    });
    expect(combineWebUsage([a, undefined])).toBeUndefined();
  });
});
