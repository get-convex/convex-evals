export const WEB_RESEARCH_LIMITS = {
  serverToolSteps: 6,
  searches: 5,
  fetches: 5,
  searchResults: 5,
  snippetChars: 1_500,
  pageTokens: 5_000,
  totalTimeoutMs: 300_000,
  maxResponseBytes: 16_000_000,
} as const;

export function requireWebResearchApiKey(env = process.env): string {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "no_guidelines_with_web requires OPENROUTER_API_KEY in .env.",
    );
  }
  return key;
}

/** Pin both engines. The default "auto" engine can vary across model providers. */
export function withWebResearchTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    tools: [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          // This is Exa's search mode, not OpenRouter's engine selection.
          mode: "auto",
          max_results: WEB_RESEARCH_LIMITS.searchResults,
          max_characters: WEB_RESEARCH_LIMITS.snippetChars,
          max_uses: WEB_RESEARCH_LIMITS.searches,
          max_total_results:
            WEB_RESEARCH_LIMITS.searches * WEB_RESEARCH_LIMITS.searchResults,
        },
      },
      {
        type: "openrouter:web_fetch",
        parameters: {
          engine: "exa",
          max_uses: WEB_RESEARCH_LIMITS.fetches,
          max_content_tokens: WEB_RESEARCH_LIMITS.pageTokens,
        },
      },
    ],
    tool_choice: "auto",
    max_tool_calls: WEB_RESEARCH_LIMITS.serverToolSteps,
  };
}
