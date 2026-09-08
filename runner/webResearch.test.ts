import { describe, it, expect } from "bun:test";
import {
  withWebResearchTools,
  requireWebResearchApiKey,
} from "./models/webResearchTools.js";
import { sdkResponseEvent } from "./models/webResearch.js";

describe("OpenRouter web configuration", () => {
  it("pins both tools without changing prompts, reasoning or model settings", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Build a backend." }],
      reasoning: { effort: "medium" },
      max_tokens: 16384,
    };
    const configured = withWebResearchTools(body);
    expect(configured).toMatchObject(body);
    expect(configured.tool_choice).toBe("auto");
    expect(configured.max_tool_calls).toBe(6);
    expect(configured.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          mode: "auto",
          max_results: 5,
          max_characters: 1500,
          max_uses: 5,
          max_total_results: 25,
        },
      },
      {
        type: "openrouter:web_fetch",
        parameters: { engine: "exa", max_uses: 5, max_content_tokens: 5000 },
      },
    ]);
    expect(body).not.toHaveProperty("tools");
  });

  it("uses only the existing OpenRouter key", () => {
    expect(
      requireWebResearchApiKey({ OPENROUTER_API_KEY: " configured " }),
    ).toBe("configured");
    expect(() => requireWebResearchApiKey({})).toThrow(
      "requires OPENROUTER_API_KEY",
    );
  });

  it("keeps complete raw Responses tool items outside the SDK parsing view", () => {
    const tool = {
      id: "fetch-1",
      type: "openrouter:web_fetch",
      content: "Full page.",
    };
    const message = { id: "msg-1", type: "message" };
    const event = {
      type: "response.completed",
      response: { output: [tool, message], usage: { cost: 0.1 } },
    };
    expect(sdkResponseEvent(event)).toEqual({
      ...event,
      response: { output: [message], usage: { cost: 0.1 } },
    });
    expect(event.response.output).toEqual([tool, message]);
    expect(
      sdkResponseEvent({ type: "response.output_item.done", item: tool }),
    ).toBeNull();
    expect(
      sdkResponseEvent({ type: "response.output_item.done", item: message }),
    ).toEqual({
      type: "response.output_item.done",
      item: message,
    });
  });
});
