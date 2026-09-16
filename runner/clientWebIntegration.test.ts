import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Model } from "./models/modelCodegen";
import { resolveModelDefaults, SYSTEM_PROMPT } from "./models/index";
import { validateClientWebRun } from "./models/clientWebResearch";
import { InfrastructureError } from "./convexBackend";
import {
  computeWebUsage,
  webUsageAverages,
} from "../evalScores/convex/webUsage";

let previous: Record<string, string | undefined>;
let fetchBefore: typeof fetch;
let dir: string;
const names = [
  "CLIENT_WEB_TOOLS",
  "DISABLE_CONVEX_REPORTING",
  "EXA_API_KEY",
  "EVALS_EXPERIMENT",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "ENABLE_CLIENT_WEB_PRODUCTION",
];
beforeEach(() => {
  previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    GITHUB_ACTIONS: "false",
    ENABLE_CLIENT_WEB_PRODUCTION: "false",
    CLIENT_WEB_TOOLS: "1",
    DISABLE_CONVEX_REPORTING: "1",
    EXA_API_KEY: "exa-test-secret",
    EVALS_EXPERIMENT: "no_guidelines_with_web",
  });
  fetchBefore = globalThis.fetch;
  dir = mkdtempSync(join(tmpdir(), "client-web-integration-"));
});
afterEach(() => {
  for (const n of names) {
    if (previous[n] === undefined) delete process.env[n];
    else process.env[n] = previous[n];
  }
  globalThis.fetch = fetchBefore;
  rmSync(dir, { recursive: true, force: true });
});
const answer =
  "# Files\n\n## convex/tasks.ts\n```typescript\nexport const complete = true;\n```";
test("real Model adapter parses files, preserves prompt/settings, and sums all paid turns and Exa costs", async () => {
  const bodies: Array<{
    messages: Record<string, unknown>[];
    max_tokens: number;
    plugins: unknown[];
  }> = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes("api.exa.ai"))
        return Response.json({
          requestId: "exa-1",
          results: [],
          costDollars: { total: 0.007 },
        });
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request");
      const body = JSON.parse(init.body) as (typeof bodies)[number];
      bodies.push(body);
      const turn = bodies.length;
      return Response.json({
        id: `gen-${turn}`,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.1,
        },
        choices: [
          {
            finish_reason: turn === 1 ? "tool_calls" : "stop",
            message:
              turn === 1
                ? {
                    role: "assistant",
                    content: null,
                    reasoning_details: [
                      { type: "reasoning.text", text: "context" },
                    ],
                    tool_calls: [
                      {
                        id: "s1",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: '{"query":"Convex mutations"}',
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: answer },
          },
        ],
      });
    },
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "or-test-secret",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("Implement tasks", {
    sessionId: "session",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.files["convex/tasks.ts"]).toContain("export const complete");
  expect(bodies[0].messages[0].content).toBe(SYSTEM_PROMPT);
  expect(bodies[0].messages[1].content).toContain("Implement tasks");
  expect(bodies[0].max_tokens).toBe(16384);
  expect(bodies[0].plugins).toEqual([]);
  expect(bodies[1].messages[2].reasoning_details).toHaveLength(1);
  expect(result.usage?.inputTokens).toBe(20);
  expect(result.usage?.raw?.cost).toBeCloseTo(0.207);
  const averages = webUsageAverages(
    computeWebUsage([
      { status: { kind: "passed", durationMs: 1, usage: result.usage } },
    ]),
  );
  expect(averages.averageWebSearchesPerEval).toBe(1);
  expect(averages.averageWebSearchesEstimated).toBe(false);
  expect(averages.averageWebFetchesPerEval).toBe(0);
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    searchAttempts: 1,
    fetchAttempts: 0,
    successfulCalls: 1,
    modelTurns: 2,
    generationIds: ["gen-1", "gen-2"],
  });
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8");
  expect(trace).not.toContain("exa-test-secret");
  expect(trace).not.toContain("or-test-secret");
});
test("opt-in refuses reporting and wrong experiment before generation", () => {
  process.env.DISABLE_CONVEX_REPORTING = "0";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow(
    "DISABLE_CONVEX_REPORTING=1",
  );
  process.env.DISABLE_CONVEX_REPORTING = "1";
  expect(() => validateClientWebRun("no_guidelines")).toThrow(
    "requires no_guidelines_with_web",
  );
});
test("production reporting requires main Actions and explicit rollout enablement", () => {
  process.env.DISABLE_CONVEX_REPORTING = "0";
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_REF = "refs/heads/main";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
  process.env.ENABLE_CLIENT_WEB_PRODUCTION = "true";
  expect(() => validateClientWebRun("no_guidelines_with_web")).not.toThrow();
  process.env.GITHUB_REF = "refs/heads/codex/pilot";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
  process.env.GITHUB_REF = "refs/heads/main";
  process.env.GITHUB_ACTIONS = "false";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
});
test("server-side web fallback cannot publish into the reset experiment", () => {
  delete process.env.CLIENT_WEB_TOOLS;
  process.env.DISABLE_CONVEX_REPORTING = "0";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow(
    "Published web runs require CLIENT_WEB_TOOLS=1",
  );
  expect(() => validateClientWebRun("no_guidelines")).not.toThrow();
});
test("token cutoff is graded like baseline without executing partial calls", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: answer,
              tool_calls: [
                {
                  id: "partial",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const work = new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  const result = await work;
  expect(result.files["convex/tasks.ts"]).toContain("complete");
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    modelOutcome: "output_limit",
    searchAttempts: 0,
    requestedCalls: 1,
    rejectedCalls: 1,
  });
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
    "output_limit",
  );
});

test("zero tool use is observed while absent model cost remains unknown", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: answer },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.usage?.raw?.cost).toBeUndefined();
  const averages = webUsageAverages(
    computeWebUsage([
      { status: { kind: "passed", durationMs: 1, usage: result.usage } },
    ]),
  );
  expect(averages.averageWebSearchesPerEval).toBe(0);
  expect(averages.averageWebSearchesEstimated).toBe(false);
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    searchAttempts: 0,
    fetchAttempts: 0,
    exaCost: 0,
  });
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
    "generation_usage",
  );
});

test("model exhausting tool turns remains a scored failure with exact rejected counts", async () => {
  let turn = 0;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.01,
        },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${++turn}`,
                  type: "function",
                  function: { name: "unknown", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.files).toEqual({});
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    modelOutcome: "tool_budget_exhausted",
    requestedCalls: 7,
    rejectedCalls: 7,
    searchAttempts: 0,
    fetchAttempts: 0,
  });
});

test("provider failure aborts as infrastructure and redacts credentials", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "or-test-secret" }, { status: 500 }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const promise = new Model(
    "or-test-secret",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  await rejects(promise, InfrastructureError);
  await rejects(
    promise,
    (error) =>
      error instanceof Error && !error.message.includes("or-test-secret"),
  );
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).not.toContain(
    "or-test-secret",
  );
});
