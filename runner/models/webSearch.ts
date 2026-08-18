/** OpenRouter executes this tool itself, using native provider search where available. */
export const OPENROUTER_WEB_SEARCH_TOOL = {
  type: "openrouter:web_search",
} as const;

export function addOpenRouterWebSearchTool(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const existingTools = Array.isArray(body.tools) ? body.tools : [];
  return {
    ...body,
    tools: [...existingTools, OPENROUTER_WEB_SEARCH_TOOL],
  };
}

export function getOpenRouterWebSearchRequestCount(
  rawUsage: unknown,
): number | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const usage = rawUsage as Record<string, unknown>;
  // The docs currently show server_tool_use, while live chat responses return
  // server_tool_use_details. Accept both so usage tracking survives that drift.
  const serverToolUse =
    usage.server_tool_use_details ?? usage.server_tool_use;
  if (!serverToolUse || typeof serverToolUse !== "object") return undefined;
  const requestCount = (serverToolUse as Record<string, unknown>)
    .web_search_requests;
  return typeof requestCount === "number" && Number.isFinite(requestCount)
    ? requestCount
    : undefined;
}
