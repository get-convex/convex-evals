import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Model } from "./models/modelCodegen.js";
import { resolveModelDefaults } from "./models/index.js";
import { WEB_RESEARCH_LIMITS } from "./models/webResearchTools.js";
import { InfrastructureError } from "./convexBackend.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const answer =
  "# Files\n\n## convex/tasks.ts\n\n\u0060\u0060\u0060typescript\nexport const complete = true;\n\u0060\u0060\u0060";
const citation = {
  type: "url_citation",
  url_citation: {
    url: "https://docs.example.com/reference",
    title: "Reference",
    start_index: 0,
    end_index: 0,
    content: "Use the documented helper.",
  },
};
const usage = {
  prompt_tokens: 40,
  completion_tokens: 200,
  total_tokens: 240,
  cost: 0.03,
  server_tool_use_details: {
    web_search_requests: 1,
    tool_calls_requested: 2,
    tool_calls_executed: 2,
  },
};
function chatEvents({ cost = true, counters = true } = {}) {
  const { cost: _cost, server_tool_use_details: _counters, ...tokens } = usage;
  return [
    {
      id: "response-1",
      model: "test-model",
      choices: [{ index: 0, delta: { annotations: [citation] } }],
    },
    { choices: [{ index: 0, delta: { content: answer } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        ...tokens,
        ...(cost ? { cost: usage.cost } : {}),
        ...(counters
          ? { server_tool_use_details: usage.server_tool_use_details }
          : {}),
      },
    },
  ];
}
function sse(events: unknown[]) {
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("web research through the real SDK adapters", () => {
  let originalFetch: typeof fetch;
  let previousExperiment: string | undefined;
  let previousGuidelines: string | undefined;
  let dir: string;
  let tracePath: string;
  let requests: Array<Record<string, unknown>>;
  let requestHeaders: Headers[];
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    previousExperiment = process.env.EVALS_EXPERIMENT;
    previousGuidelines = process.env.CUSTOM_GUIDELINES_PATH;
    process.env.EVALS_EXPERIMENT = "no_guidelines_with_web";
    delete process.env.CUSTOM_GUIDELINES_PATH;
    dir = mkdtempSync(join(tmpdir(), "web-model-integration-"));
    tracePath = join(dir, "trace.json");
    requests = [];
    requestHeaders = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousExperiment === undefined) delete process.env.EVALS_EXPERIMENT;
    else process.env.EVALS_EXPERIMENT = previousExperiment;
    if (previousGuidelines === undefined)
      delete process.env.CUSTOM_GUIDELINES_PATH;
    else process.env.CUSTOM_GUIDELINES_PATH = previousGuidelines;
    rmSync(dir, { recursive: true, force: true });
  });
  function stub(
    response: () => Response,
    apiKind: "chat" | "responses" = "chat",
  ) {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const endpoint =
          apiKind === "chat" ? "/chat/completions" : "/responses";
        expect(String(input)).toBe("https://openrouter.ai/api/v1" + endpoint);
        requests.push(JSON.parse(String(init?.body)));
        requestHeaders.push(new Headers(init?.headers));
        return response();
      },
      { preconnect: originalFetch.preconnect },
    );
    return new Model("test-model-secret", {
      ...resolveModelDefaults(
        apiKind === "responses" ? "gpt-5.6-luna" : "test-model",
      ),
      apiKind,
    });
  }
  function saved() {
    return JSON.parse(readFileSync(tracePath, "utf8"));
  }

  it("pins Exa, preserves source excerpts and reported total cost, and needs one API key", async () => {
    const model = stub(() => sse(chatEvents()));
    const result = await model.generate("Build a backend.", {
      webTracePath: tracePath,
    });
    expect(result.files["convex/tasks.ts"]).toContain("complete = true");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toHaveLength(2);
    expect(requests[0]!.tools).toMatchObject([
      { type: "openrouter:web_search", parameters: { engine: "exa" } },
      { type: "openrouter:web_fetch", parameters: { engine: "exa" } },
    ]);
    expect(requests[0]!.reasoning).toEqual({ effort: "medium" });
    expect(requests[0]!.max_tokens).toBe(16384);
    expect(requestHeaders[0]!.get("X-OpenRouter-Metadata")).toBe("enabled");
    expect(result.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 200,
      raw: {
        cost: 0.03,
        webResearch: {
          searchRequests: 1,
          fetchRequests: null,
          toolCallsExecuted: 2,
          coverage: "provider-visible-only",
        },
      },
    });
    expect(saved()).toMatchObject({
      status: "completed",
      searchEngine: "exa",
      fetchEngine: "exa",
      citations: [citation],
    });
    expect(saved().requests[0].events).toEqual(chatEvents());
    expect(readFileSync(tracePath, "utf8")).not.toContain("test-model-secret");
  });

  it("keeps unknown cost and missing search counters unknown", async () => {
    const model = stub(() => sse(chatEvents({ cost: false, counters: false })));
    const result = await model.generate("Build a backend.", {
      webTracePath: tracePath,
    });
    expect(result.usage?.raw).not.toHaveProperty("cost");
    expect(result.usage?.raw).not.toHaveProperty("costEstimatedFromPricing");
    expect(saved().summary.searchRequests).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("allows the model to answer without searching", async () => {
    const events = chatEvents();
    events.shift();
    events[1]!.usage!.server_tool_use_details = {
      web_search_requests: 0,
      tool_calls_requested: 0,
      tool_calls_executed: 0,
    };
    const model = stub(() => sse(events));
    await model.generate("Build a backend.", { webTracePath: tracePath });
    expect(saved().summary.searchRequests).toBe(0);
    expect(saved().citations).toEqual([]);
    expect(requests[0]!.tool_choice).toBe("auto");
  });

  it("keeps the baseline request free of web tools and its prompt identical", async () => {
    const model = stub(() => sse(chatEvents()));
    await model.generate("Build a backend.");
    process.env.EVALS_EXPERIMENT = "no_guidelines";
    await model.generate("Build a backend.");
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    expect(requests[1]!.tools).toBeUndefined();
    expect(requestHeaders[1]!.get("X-OpenRouter-Metadata")).toBeNull();
  });

  it.each(["completed", "incomplete"])(
    "retains Responses tools and usage for a %s generation",
    async (status) => {
      const search = {
        id: "search-1",
        type: "openrouter:web_search",
        status: "completed",
        action: {
          type: "search",
          query: "new API",
          sources: [{ type: "url", url: "https://docs.example.com/reference" }],
        },
      };
      const page = {
        id: "fetch-1",
        type: "openrouter:web_fetch",
        status: "completed",
        url: "https://docs.example.com/reference",
        content: "Full extracted page.",
        httpStatus: 200,
      };
      const message = {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "response-1", created_at: 1, model: "test-model" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...search, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: 0, item: search },
        { type: "response.output_item.done", output_index: 1, item: page },
        { type: "response.output_item.added", output_index: 2, item: message },
        {
          type: "response.output_text.delta",
          item_id: "msg-1",
          output_index: 2,
          content_index: 0,
          delta: answer,
        },
        { type: "response.output_item.done", output_index: 2, item: message },
        {
          type: "response." + status,
          response: {
            ...(status === "incomplete"
              ? { incomplete_details: { reason: "max_output_tokens" } }
              : {}),
            output: [search, page, message],
            usage: {
              input_tokens: 40,
              output_tokens: 200,
              total_tokens: 240,
              cost: 0.03,
              server_tool_use_details: usage.server_tool_use_details,
            },
            openrouter_metadata: {
              pipeline: [{ type: "server_tools", data: { mode: "sdk" } }],
            },
          },
        },
      ];
      const model = stub(() => sse(events), "responses");
      const result = await model.generate("Build a backend.", {
        webTracePath: tracePath,
      });
      expect(result.files["convex/tasks.ts"]).toContain("complete = true");
      expect(saved().serverToolItems).toEqual([search, page]);
      expect(saved().requests[0].events).toEqual(events);
      expect(saved().summary).toMatchObject({
        observedSearchItems: 1,
        observedFetchItems: 1,
      });
      expect(saved().routerMetadata.pipeline[0].type).toBe("server_tools");
      expect(result.usage?.raw?.cost).toBe(0.03);
      expect(requests[0]!.max_output_tokens).toBe(16384);
      expect(requests[0]!.reasoning).toMatchObject({ effort: "medium" });
    },
  );

  it.each(["provider error", "truncated stream", "oversized stream"])(
    "preserves traces and classifies %s as infrastructure failure",
    async (kind) => {
      const model = stub(() => {
        const events: unknown[] = chatEvents().slice(0, 2);
        if (kind === "provider error")
          events.push({ error: { message: "failure test-model-secret" } });
        if (kind === "oversized stream")
          return new Response(
            "x".repeat(WEB_RESEARCH_LIMITS.maxResponseBytes + 1),
          );
        return sse(events);
      });
      const silence = spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          model.generate("Build a backend.", { webTracePath: tracePath }),
        ).rejects.toBeInstanceOf(InfrastructureError);
        expect(saved().status).toBe("failed");
        expect(readFileSync(tracePath, "utf8")).not.toContain(
          "test-model-secret",
        );
        if (kind !== "oversized stream")
          expect(saved().citations).toEqual([citation]);
      } finally {
        silence.mockRestore();
      }
    },
  );
});
