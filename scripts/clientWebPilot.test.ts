import { describe, expect, test } from "bun:test";
import {
  ClientWebTools,
  summarizeToolEvents,
  type Event,
  type ToolCall,
} from "./lib/clientWebTools";
import { runClientWebPilot } from "./clientWebPilot";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJournal } from "./lib/clientWebTools";

const call = (
  id: string,
  name = "web_search",
  args = { query: "Convex transactions" },
): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(
  fetch?: (url: string, init: RequestInit) => Promise<Response>,
) {
  const events: Event[] = [];
  const network: string[] = [];
  const tools = new ClientWebTools({
    exaKey: "test",
    journal: (e) => {
      events.push(e);
    },
    fetch: async (url, init) => {
      expect(events.at(-1)?.kind).toBe("dispatch_prepared");
      network.push(url);
      return fetch
        ? fetch(url, init)
        : Response.json({
            results: [
              {
                url: "https://docs.convex.dev",
                highlights: ["A result"],
                text: "Page body",
              },
            ],
            requestId: "exa-test",
          });
    },
  });
  return { tools, events, network };
}

describe("client-owned web accounting", () => {
  test("final-answer turn preserves tools and ends after all six dispatch slots", async () => {
    let turn = 0;
    const result = await runClientWebPilot({
      model: "fixture",
      prompt: "budget test",
      openrouterKey: "test",
      exaKey: "test",
      journal: () => {},
      modelFetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (turn++ === 0)
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    ...Array.from({ length: 5 }, (_, i) => call(String(i))),
                    {
                      id: "fetch",
                      type: "function",
                      function: {
                        name: "web_fetch",
                        arguments: '{"url":"https://example.com"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        expect(body.messages.at(-1).content).toContain(
          "budget is now exhausted",
        );
        expect(body.tools).toHaveLength(2);
        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        });
      },
      toolFetch: async () =>
        Response.json({
          results: [
            {
              url: "https://example.com",
              text: "content",
              highlights: ["excerpt"],
            },
          ],
        }),
    });
    expect(result.summary).toMatchObject({
      searchAttempts: 5,
      fetchAttempts: 1,
      successfulCalls: 6,
    });
    expect(result.turns).toBe(2);
  });
  test("zero starts explicitly at zero", () => {
    expect(fixture().tools.summary()).toMatchObject({
      requestedCalls: 0,
      searchAttempts: 0,
      fetchAttempts: 0,
      unknownOutcomes: 0,
    });
  });
  test("search/fetch counters reconcile with independent outgoing requests", async () => {
    const { tools, network, events } = fixture();
    await tools.execute(call("1"));
    await tools.execute({
      id: "2",
      type: "function",
      function: {
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://docs.convex.dev" }),
      },
    });
    expect(network).toEqual([
      "https://api.exa.ai/search",
      "https://api.exa.ai/contents",
    ]);
    expect(tools.summary()).toMatchObject({
      searchAttempts: 1,
      fetchAttempts: 1,
      successfulCalls: 2,
      incompleteAttempts: 0,
    });
    expect(summarizeToolEvents(JSON.parse(JSON.stringify(events)))).toEqual(
      tools.summary(),
    );
  });
  test("invalid JSON, unknown tools, duplicate IDs never dispatch", async () => {
    const { tools, network } = fixture();
    await tools.execute({
      ...call("a"),
      function: { name: "web_search", arguments: "{" },
    });
    await tools.execute(call("b", "shell"));
    await tools.execute(call("a"));
    expect(network).toHaveLength(0);
    expect(tools.summary().rejectedCalls).toBe(3);
  });
  test("enforces per-tool and total limits across batched calls", async () => {
    const { tools, network } = fixture();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => tools.execute(call(String(i)))),
    );
    expect(network).toHaveLength(5);
    const fetchCall = (id: string): ToolCall => ({
      id,
      type: "function",
      function: {
        name: "web_fetch",
        arguments: '{"url":"https://example.com"}',
      },
    });
    await tools.execute(fetchCall("f1"));
    await tools.execute(fetchCall("f2"));
    expect(network).toHaveLength(6);
    expect(tools.summary().rejectedCalls).toBe(4);
    const s = tools.summary();
    expect(s.searchAttempts + s.fetchAttempts).toBe(
      s.successfulCalls +
        s.failedCalls +
        s.unknownOutcomes +
        s.incompleteAttempts,
    );
  });
  test("HTTP error and transport failure are recorded without hidden retries", async () => {
    const a = fixture(async () =>
      Response.json({ error: "rate limit" }, { status: 429 }),
    );
    await a.tools.execute(call("1"));
    expect(a.tools.summary()).toMatchObject({
      searchAttempts: 1,
      failedCalls: 1,
    });
    const b = fixture(async () => {
      throw new Error("socket closed after request");
    });
    await b.tools.execute(call("1"));
    expect(b.network).toHaveLength(1);
    expect(b.tools.summary()).toMatchObject({
      searchAttempts: 1,
      unknownOutcomes: 1,
    });
    await b.tools.execute(call("2"));
    expect(b.tools.summary().searchAttempts).toBe(2);
  });
  test("per-URL fetch failure in HTTP 200 is not success", async () => {
    const { tools } = fixture(async () =>
      Response.json({ results: [], statuses: [{ status: "error" }] }),
    );
    await tools.execute({
      id: "1",
      type: "function",
      function: {
        name: "web_fetch",
        arguments: '{"url":"https://example.com"}',
      },
    });
    expect(tools.summary()).toMatchObject({
      fetchAttempts: 1,
      failedCalls: 1,
      successfulCalls: 0,
    });
  });
  test("journal failure stops before network; unfinished entries remain incomplete", async () => {
    let network = 0;
    const tools = new ClientWebTools({
      exaKey: "test",
      journal: (e) => {
        if (e.kind === "dispatch_prepared") throw new Error("disk full");
      },
      fetch: async () => {
        network++;
        return Response.json({});
      },
    });
    await expect(tools.execute(call("1"))).rejects.toThrow("disk full");
    expect(network).toBe(0);
    expect(
      summarizeToolEvents([
        { kind: "dispatch_prepared", tool: "web_search", invocation: 1 },
      ]).incompleteAttempts,
    ).toBe(1);
  });
  test("model loop returns results under correct IDs and preserves reasoning", async () => {
    const events: Event[] = [];
    let modelRequests = 0;
    let toolRequests = 0;
    const reasoning = [{ type: "reasoning.text", text: "Need sources" }];
    const result = await runClientWebPilot({
      model: "fixture",
      prompt: "test",
      openrouterKey: "test",
      exaKey: "test",
      journal: (e) => {
        events.push(e);
      },
      modelFetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.tools.every((t: any) => t.type === "function")).toBe(true);
        if (modelRequests++ === 0)
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_details: reasoning,
                  tool_calls: [call("s1"), call("s2")],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        expect(body.messages[2].reasoning_details).toEqual(reasoning);
        expect(body.messages.slice(3).map((m: any) => m.tool_call_id)).toEqual([
          "s1",
          "s2",
        ]);
        return Response.json({
          choices: [
            {
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        });
      },
      toolFetch: async () => {
        toolRequests++;
        return Response.json({ results: [] });
      },
    });
    expect(toolRequests).toBe(2);
    expect(result.summary.searchAttempts).toBe(toolRequests);
    expect(events.at(-1)?.kind).toBe("pilot_completed");
  });
  test("real HTTP transport sends once for 429, 500, garbled JSON and timeout", async () => {
    const inbound: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        inbound.push(path);
        if (path === "/429" || path === "/500")
          return Response.json(
            { error: "injected" },
            { status: Number(path.slice(1)) },
          );
        if (path === "/bad-json") return new Response("not JSON");
        return new Promise<Response>(() => {});
      },
    });
    try {
      for (const path of ["/429", "/500", "/bad-json", "/timeout"]) {
        const tools = new ClientWebTools({
          exaKey: "test",
          journal: () => {},
          timeoutMs: 50,
          fetch: (_url, init) => fetch(new URL(path, server.url), init),
        });
        await tools.execute(call(path));
        expect(tools.summary()).toMatchObject({
          searchAttempts: 1,
          successfulCalls: 0,
          incompleteAttempts: 0,
          failedCalls: path === "/timeout" ? 0 : 1,
          unknownOutcomes: path === "/timeout" ? 1 : 0,
        });
      }
      expect(inbound).toEqual(["/429", "/500", "/bad-json", "/timeout"]);
    } finally {
      server.stop(true);
    }
  });
  test("SIGKILL mid-request leaves a durable incomplete record, not success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-pilot-kill-"));
    let received!: () => void;
    const inbound = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        received();
        return new Promise<Response>(() => {});
      },
    });
    const script = join(dir, "child.ts");
    const journalPath = join(dir, "events.jsonl");
    writeFileSync(
      script,
      `import {ClientWebTools,createJournal} from ${JSON.stringify(resolve("scripts/lib/clientWebTools.ts"))};\nawait new ClientWebTools({exaKey:'test',journal:createJournal(${JSON.stringify(journalPath)}),fetch:(_url,init)=>fetch(${JSON.stringify(server.url.toString())},init)}).execute(${JSON.stringify(call("kill"))});`,
    );
    const child = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await inbound;
      child.kill("SIGKILL");
      await child.exited;
      const events = readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(summarizeToolEvents(events)).toMatchObject({
        requestedCalls: 1,
        searchAttempts: 1,
        successfulCalls: 0,
        incompleteAttempts: 1,
      });
      const replay = readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(summarizeToolEvents(replay)).toEqual({
        requestedCalls: 1,
        searchAttempts: 1,
        fetchAttempts: 0,
        successfulCalls: 0,
        failedCalls: 0,
        rejectedCalls: 0,
        unknownOutcomes: 0,
        incompleteAttempts: 1,
      });
    } finally {
      child.kill();
      server.stop(true);
      rmSync(dir, { recursive: true });
    }
  }, 10000);
  test("persistent journal redacts credentials and refuses file reuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-pilot-journal-"));
    try {
      const path = join(dir, "events.jsonl");
      const journal = createJournal(path, ["secret-key"]);
      journal({ kind: "error", message: "Oops secret-key" });
      expect(readFileSync(path, "utf8")).not.toContain("secret-key");
      expect(() => createJournal(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  test("unexpected result shapes terminate as failed and special-token text is readable", async () => {
    for (const data of [
      null,
      { results: [null] },
      { results: [{ url: "https://example.com", text: 12 }] },
    ]) {
      const { tools, events } = fixture(async () => Response.json(data));
      await tools.execute({
        id: "fetch",
        type: "function",
        function: {
          name: "web_fetch",
          arguments: '{"url":"https://example.com"}',
        },
      });
      expect(tools.summary()).toMatchObject({
        failedCalls: 1,
        incompleteAttempts: 0,
      });
      expect(events.at(-1)?.httpStatus).toBe(200);
    }
    const { tools } = fixture(async () =>
      Response.json({
        results: [
          { url: "https://example.com", text: "text <|endoftext|> more" },
        ],
      }),
    );
    const result = await tools.execute({
      id: "fetch",
      type: "function",
      function: {
        name: "web_fetch",
        arguments: '{"url":"https://example.com"}',
      },
    });
    expect(JSON.parse(result).results[0].text).toBe("text <|endoftext|> more");
    expect(tools.summary().successfulCalls).toBe(1);
  });
  test("truncated tool turns never execute", async () => {
    let requests = 0;
    await expect(
      runClientWebPilot({
        model: "fixture",
        prompt: "test",
        exaKey: "test",
        openrouterKey: "test",
        journal: () => {},
        modelFetch: async () =>
          Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [call("1")],
                },
                finish_reason: "length",
              },
            ],
          }),
        toolFetch: async () => {
          requests++;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("incomplete tool-call turn");
    expect(requests).toBe(0);
  });
});
