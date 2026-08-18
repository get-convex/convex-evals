import { describe, expect, it } from "bun:test";
import {
  addOpenRouterWebSearchTool,
  getOpenRouterWebSearchRequestCount,
  OPENROUTER_WEB_SEARCH_TOOL,
} from "./models/webSearch.js";

describe("OpenRouter web search", () => {
  it("adds the server tool without replacing existing tools", () => {
    const existingTool = {
      type: "function",
      function: { name: "example" },
    };

    expect(addOpenRouterWebSearchTool({ tools: [existingTool] })).toEqual({
      tools: [existingTool, OPENROUTER_WEB_SEARCH_TOOL],
    });
  });

  it("reads the provider-reported search request count", () => {
    expect(
      getOpenRouterWebSearchRequestCount({
        server_tool_use: { web_search_requests: 3 },
      }),
    ).toBe(3);
  });

  it("reads the search count shape returned by the live chat API", () => {
    expect(
      getOpenRouterWebSearchRequestCount({
        server_tool_use_details: { web_search_requests: 2 },
      }),
    ).toBe(2);
  });

  it("does not invent a count when OpenRouter did not report one", () => {
    expect(getOpenRouterWebSearchRequestCount({})).toBeUndefined();
  });
});
