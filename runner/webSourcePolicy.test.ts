import { describe, expect, test } from "bun:test";
import { runClientWebLoop } from "./models/clientWebLoop";
import {
  ClientWebTools,
  type Event,
  type ToolCall,
} from "./models/clientWebTools";
import {
  benchmarkSourceReason,
  webSourceUrlReason,
} from "./models/webSourcePolicy";

function setup(results: unknown[], status = 200) {
  const events: Event[] = [];
  let dispatched = 0;
  const tools = new ClientWebTools({
    exaKey: "test",
    journal: (event) => {
      events.push(event);
    },
    fetch: async () => {
      dispatched++;
      return Response.json(
        { results, statuses: [{ error: "convex-evals ANSWER" }] },
        { status },
      );
    },
  });
  const call = (name: string, args: object): ToolCall => ({
    id: String(events.length),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  return { tools, events, dispatched: () => dispatched, call };
}

describe("benchmark source filtering", () => {
  test("the next model turn sees filtered results, never the raw audit payload", async () => {
    let turn = 0;
    const events: Event[] = [];
    await runClientWebLoop({
      model: "fixture",
      prompt: "Build a backend",
      openrouterKey: "test",
      exaKey: "test",
      journal: (event) => {
        events.push(event);
      },
      modelFetch: async (_url, init) => {
        if (typeof init.body !== "string")
          throw new Error("Expected JSON body");
        const body = JSON.parse(init.body) as {
          messages: { content: string }[];
        };
        if (turn++ === 0)
          return Response.json({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "1",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: '{"query":"Convex functions"}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        expect(body.messages.at(-1)?.content).toContain("Normal docs");
        expect(JSON.stringify(body)).not.toContain("BENCHMARK_ANSWER");
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "done" },
            },
          ],
        });
      },
      toolFetch: async () =>
        Response.json({
          results: [
            {
              url: "https://stack.convex.dev/convex-evals",
              highlights: ["BENCHMARK_ANSWER"],
            },
            { url: "https://docs.convex.dev", highlights: ["Normal docs"] },
          ],
        }),
    });
    expect(turn).toBe(2);
    expect(
      JSON.stringify(events.find((e) => e.kind === "tool_result")?.rawResponse),
    ).toContain("BENCHMARK_ANSWER");
  });
  test("malformed provider bodies cannot leak through parser errors", async () => {
    const events: Event[] = [];
    const tools = new ClientWebTools({
      exaKey: "test",
      journal: (event) => {
        events.push(event);
      },
      fetch: async () => new Response("convex-evals ANSWER, invalid JSON"),
    });
    const response = await tools.execute({
      id: "1",
      type: "function",
      function: { name: "web_search", arguments: '{"query":"Convex"}' },
    });
    expect(JSON.parse(response)).toEqual({
      error: "Search service returned an unusable response",
    });
    expect(events.at(-1)?.processingError).toBeDefined();
  });
  test.each([
    "https://github.com/get-convex/convex-evals/blob/main/evals/task/answer/index.ts",
    "https://raw.githubusercontent.com/get-convex/convex-evals/main/evals/task/grader.test.ts",
    "https://github.com/a-fork/convex-evals",
    "https://cdn.jsdelivr.net/gh/get-convex/convex-evals@main/file",
    "https://stack.convex.dev/convex-evals?utm_source=test",
    "https://r.jina.ai/https://github.com/get-convex/convex-evals",
    "https://mirror.example/CONVEX%252dEVALS/answer",
  ])("rejects known source before dispatch: %s", async (url) => {
    const f = setup([]);
    expect(
      JSON.parse(await f.tools.execute(f.call("web_fetch", { url }))),
    ).toHaveProperty("error");
    expect(f.dispatched()).toBe(0);
    expect(f.tools.summary().rejectedCalls).toBe(1);
  });

  test("rejects explicit benchmark searches without blocking ordinary documentation queries", async () => {
    const f = setup([]);
    await f.tools.execute(
      f.call("web_search", { query: "get-convex/convex-evals grader.test.ts" }),
    );
    expect(f.dispatched()).toBe(0);
    await f.tools.execute(
      f.call("web_search", { query: "Convex cronJobs interval docs" }),
    );
    expect(f.dispatched()).toBe(1);
    expect(
      webSourceUrlReason("https://github.com/get-convex/convex-js"),
    ).toBeUndefined();
    expect(
      webSourceUrlReason("https://docs.convex.dev/scheduling/cron-jobs"),
    ).toBeUndefined();
  });

  test("removes benchmark results and mirrored snippets before returning any content", async () => {
    const f = setup([
      {
        url: "https://github.com/get-convex/convex-evals",
        highlights: ["ANSWER"],
      },
      {
        url: "https://mirror.example/page",
        title: "Convex Evals: Behind the scenes",
        highlights: ["ANSWER"],
      },
      { url: "https://docs.convex.dev", highlights: ["Normal docs"] },
    ]);
    const result = await f.tools.execute(
      f.call("web_search", { query: "Convex functions" }),
    );
    expect((JSON.parse(result) as { results: unknown[] }).results).toEqual([
      { url: "https://docs.convex.dev", excerpts: "Normal docs" },
    ]);
    expect(result).not.toContain("ANSWER");
    expect(f.events.filter((e) => e.kind === "source_blocked")).toHaveLength(2);
    expect(f.events.at(-1)?.rawResponse).toHaveProperty("results");
  });

  test("blocks returned redirect URLs and benchmark text under innocuous URLs", async () => {
    for (const result of [
      { url: "https://stack.convex.dev/convex-evals", text: "ANSWER" },
      {
        url: "https://mirror.example/page",
        text: "from get-convex/convex-evals ANSWER",
      },
      {
        url: "https://mirror.example/page",
        text: "emptyPublicQuery emptyPublicMutation emptyPrivateQuery emptyPrivateMutation ANSWER",
      },
    ]) {
      const f = setup([result]);
      expect(
        JSON.parse(
          await f.tools.execute(
            f.call("web_fetch", { url: "https://mirror.example/page" }),
          ),
        ),
      ).toEqual({ results: [] });
      expect(f.tools.summary().fetchAttempts).toBe(1);
    }
  });

  test("examines full content before clipping and fails closed on invalid result URLs", async () => {
    const f = setup([
      {
        url: "https://mirror.example/page",
        text: "normal ".repeat(6000) + "convex-evals ANSWER",
      },
    ]);
    expect(
      JSON.parse(
        await f.tools.execute(
          f.call("web_fetch", { url: "https://mirror.example/page" }),
        ),
      ),
    ).toEqual({ results: [] });
    expect(webSourceUrlReason("javascript:alert(1)")).toBeDefined();
    expect(webSourceUrlReason("https://user:pass@example.com")).toBeDefined();
    expect(
      benchmarkSourceReason("normal docs %zz convex%2devals"),
    ).toBeDefined();
  });

  test("does not leak provider error content into model messages", async () => {
    const f = setup([], 400);
    const response = await f.tools.execute(
      f.call("web_search", { query: "Convex" }),
    );
    expect(response).not.toContain("ANSWER");
    expect(f.events.at(-1)?.rawResponse).toHaveProperty("statuses");
  });
});
