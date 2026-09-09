import type { Doc } from "./_generated/dataModel";

export type WebUsage = {
  evalCount: number;
  reportedSearchEvalCount: number;
  inferredZeroSearchEvalCount: number;
  searchRequests: number;
  reportedFetchEvalCount: number;
  fetchRequests: number;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function computeWebUsage(
  evals: Pick<Doc<"evals">, "status">[],
): WebUsage {
  const result: WebUsage = {
    evalCount: 0,
    reportedSearchEvalCount: 0,
    inferredZeroSearchEvalCount: 0,
    searchRequests: 0,
    reportedFetchEvalCount: 0,
    fetchRequests: 0,
  };
  for (const { status } of evals) {
    if (status.kind !== "passed" && status.kind !== "failed") continue;
    result.evalCount++;
    const raw = record(status.usage?.raw);
    const research = record(raw.webResearch);
    const counters = record(raw.server_tool_use_details ?? raw.server_tool_use);
    const searches = count(
      counters.web_search_requests ?? research.searchRequests,
    );
    const fetches = count(
      counters.web_fetch_requests ?? research.fetchRequests,
    );
    if (searches !== null) {
      result.reportedSearchEvalCount++;
      result.searchRequests += searches;
    } else {
      const upstreamCost = record(raw.cost_details).upstream_inference_cost;
      // The audited Exa traces omit counters on responses with no citations or
      // extra tool charge. Keep this as an explicit inference, never raw zero.
      const inferredZero =
        research.searchEngine === "exa" &&
        research.fetchEngine === "exa" &&
        research.requestAttempts === 1 &&
        research.sourceCitations === 0 &&
        (research.toolCallsExecuted == null ||
          research.toolCallsExecuted === 0) &&
        (counters.tool_calls_executed == null ||
          counters.tool_calls_executed === 0) &&
        typeof raw.cost === "number" &&
        Number.isFinite(raw.cost) &&
        raw.cost >= 0 &&
        typeof upstreamCost === "number" &&
        Number.isFinite(upstreamCost) &&
        upstreamCost >= 0 &&
        Math.abs(raw.cost - upstreamCost) < 1e-8;
      if (inferredZero) result.inferredZeroSearchEvalCount++;
    }
    if (fetches !== null) {
      result.reportedFetchEvalCount++;
      result.fetchRequests += fetches;
    }
  }
  return result;
}

export function combineWebUsage(
  rows: Array<WebUsage | undefined>,
): WebUsage | undefined {
  // Older materialized rows have no denominator. Do not present a partial
  // aggregate as complete when displaying results across benchmark versions.
  if (rows.length === 0 || rows.some((row) => row === undefined))
    return undefined;
  const result = computeWebUsage([]);
  for (const row of rows) {
    for (const key of Object.keys(result) as Array<keyof WebUsage>)
      result[key] += row![key];
  }
  return result;
}

export function webUsageAverages(usage: WebUsage | undefined) {
  const completeSearches =
    usage &&
    usage.evalCount > 0 &&
    usage.reportedSearchEvalCount + usage.inferredZeroSearchEvalCount ===
      usage.evalCount;
  return {
    averageWebSearchesPerEval: completeSearches
      ? usage.searchRequests / usage.evalCount
      : null,
    averageWebSearchesEstimated: Boolean(
      completeSearches && usage.inferredZeroSearchEvalCount > 0,
    ),
    averageWebFetchesPerEval:
      usage &&
      usage.evalCount > 0 &&
      usage.reportedFetchEvalCount === usage.evalCount
        ? usage.fetchRequests / usage.evalCount
        : null,
    webSearchTelemetryEvalCount: usage?.reportedSearchEvalCount ?? 0,
    webUsageEvalCount: usage?.evalCount ?? 0,
  };
}
