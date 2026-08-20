import { describe, expect, it } from "bun:test";
import {
  buildNativeHarnessInvocation,
  parseNativeHarnessUsage,
} from "./models/nativeHarness.js";

describe("native harness invocation", () => {
  it("gives Codex live search while keeping shell network disabled", () => {
    const invocation = buildNativeHarnessInvocation(
      { name: "codex", webSearch: true },
      "openai/gpt-5.6-sol",
      "/tmp/eval",
      "prompt",
    );

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain('web_search="live"');
    expect(invocation.args).toContain("tools.web_search=true");
    expect(invocation.args).toContain(
      "sandbox_workspace_write.network_access=false",
    );
  });

  it("removes Codex search in the no-web condition", () => {
    const invocation = buildNativeHarnessInvocation(
      { name: "codex", webSearch: false },
      "openai/gpt-5.6-luna",
      "/tmp/eval",
      "prompt",
    );

    expect(invocation.args).toContain('web_search="disabled"');
    expect(invocation.args).toContain("tools.web_search=false");
  });

  it("blocks both Claude web tools and shell network without web", () => {
    const invocation = buildNativeHarnessInvocation(
      { name: "claude", webSearch: false },
      "anthropic/claude-sonnet-5",
      "/tmp/eval",
      "prompt",
    );
    const settingsIndex = invocation.args.indexOf("--settings");
    const settings = JSON.parse(invocation.args[settingsIndex + 1]);

    expect(settings.permissions.deny).toContain("WebSearch");
    expect(settings.permissions.deny).toContain("WebFetch");
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    expect(settings.sandbox.network.strictAllowlist).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it("allows Claude web tools without opening shell network", () => {
    const invocation = buildNativeHarnessInvocation(
      { name: "claude", webSearch: true },
      "anthropic/claude-opus-5",
      "/tmp/eval",
      "prompt",
    );
    const settingsIndex = invocation.args.indexOf("--settings");
    const settings = JSON.parse(invocation.args[settingsIndex + 1]);

    expect(settings.permissions.allow).toContain("WebSearch");
    expect(settings.permissions.allow).toContain("WebFetch(domain:*)");
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
  });

  it("uses Grok's strict sandbox in both conditions", () => {
    const withWeb = buildNativeHarnessInvocation(
      { name: "grok", webSearch: true },
      "x-ai/grok-4.6",
      "/tmp/eval",
      "prompt",
    );
    const withoutWeb = buildNativeHarnessInvocation(
      { name: "grok", webSearch: false },
      "x-ai/grok-4.5",
      "/tmp/eval",
      "prompt",
    );

    expect(withWeb.args).toContain("strict");
    expect(withWeb.args).not.toContain("--disable-web-search");
    expect(withoutWeb.args).toContain("strict");
    expect(withoutWeb.args).toContain("--disable-web-search");
  });

  it("rejects a model assigned to the wrong harness", () => {
    expect(() =>
      buildNativeHarnessInvocation(
        { name: "grok", webSearch: true },
        "openai/gpt-5.6-sol",
        "/tmp/eval",
        "prompt",
      ),
    ).toThrow("not configured for the grok native harness");
  });
});

describe("native harness usage", () => {
  it("counts completed Codex search calls", () => {
    const stdout = [
      JSON.stringify({
        type: "item.started",
        item: { type: "web_search" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "web_search" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 80,
        },
      }),
    ].join("\n");

    const parsed = parseNativeHarnessUsage("codex", stdout);
    expect(parsed?.inputTokens).toBe(100);
    expect(parsed?.outputTokens).toBe(20);
    expect(parsed?.raw).toMatchObject({ webSearchRequestCount: 1 });
  });

  it("includes Claude searches performed by its helper model", () => {
    const parsed = parseNativeHarnessUsage(
      "claude",
      JSON.stringify({
        total_cost_usd: 0.25,
        num_turns: 4,
        usage: { input_tokens: 8, output_tokens: 351 },
        modelUsage: {
          "claude-haiku": { webSearchRequests: 2 },
          "claude-sonnet": { webSearchRequests: 0 },
        },
      }),
    );

    expect(parsed?.raw).toMatchObject({
      webSearchRequestCount: 2,
      cost: 0.25,
      numTurns: 4,
    });
  });

  it("reads Grok's reported search and token usage", () => {
    const parsed = parseNativeHarnessUsage(
      "grok",
      JSON.stringify({
        total_cost_usd: 0.03,
        num_turns: 3,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          server_tool_use: { web_search_requests: 1 },
        },
      }),
    );

    expect(parsed?.totalTokens).toBe(150);
    expect(parsed?.raw).toMatchObject({
      webSearchRequestCount: 1,
      cost: 0.03,
    });
  });
});
