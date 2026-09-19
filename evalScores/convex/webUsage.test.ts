import { describe, expect, it } from "vitest";
import { combineWebUsage, computeWebUsage, webUsageAverages } from "./webUsage";
import type { CodingEval } from "./documentKinds";
import { computeRunCostUsd } from "./scoringUtils";
const evalWith = (
  raw: Record<string, unknown>,
): Pick<CodingEval, "status"> => ({
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
  it.each([
    zeroEvidence,
    {
      cost: 0.25,
      server_tool_use_details: {
        web_search_requests: 3,
        web_fetch_requests: 2,
      },
    },
  ])(
    "excludes recovered-attempt telemetry without treating it as zero: %j",
    (raw) => {
      const evals = [
        evalWith({
          cost: 0.5,
          server_tool_use_details: {
            web_search_requests: 1,
            web_fetch_requests: 1,
          },
        }),
        evalWith({ ...raw, providerUsageExcludesFailedAttempts: true }),
      ];
      expect(computeRunCostUsd(evals as CodingEval[])).toBeNull();
      expect(webUsageAverages(computeWebUsage(evals))).toMatchObject({
        averageWebSearchesPerEval: null,
        averageWebFetchesPerEval: null,
        webUsageEvalCount: 2,
        webSearchTelemetryEvalCount: 1,
      });
      expect(computeWebUsage(evals).inferredZeroSearchEvalCount).toBe(0);
    },
  );

  it("retains ordinary costs when no failed attempts were excluded", () => {
    const evals = [
      evalWith({ cost: 0.5 }),
      evalWith({ cost: 0.25, providerUsageExcludesFailedAttempts: false }),
    ];
    expect(computeRunCostUsd(evals as CodingEval[])).toBe(0.75);
  });

  it("keeps a run cost unknown when any terminal eval lacks cost", () => {
    const evals = [evalWith({ cost: 0.25 }), evalWith({})];
    expect(computeRunCostUsd(evals as CodingEval[])).toBeNull();
  });

  it("keeps retry cost unknown for provider attempts outside web runs", () => {
    const evals = [
      evalWith({
        cost: 0.25,
        providerAttempts: [
          { outcome: "empty_response" },
          { outcome: "success" },
        ],
      }),
    ];
    expect(computeRunCostUsd(evals as CodingEval[])).toBeNull();
  });

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
