import { afterEach, describe, expect, it } from "bun:test";
import {
  preflightOpenRouterEndpoint,
  resolveModel,
} from "./openRouterDiscovery.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveModel", () => {
  it("falls back to the OpenRouter catalog when frontend search misses", async () => {
    const mockFetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/api/frontend/models/find")) {
        return new Response("not found", {
          status: 404,
          statusText: "Not Found",
        });
      }

      if (url.includes("/api/v1/models")) {
        return Response.json({
          data: [
            {
              id: "anthropic/claude-fable-5",
              canonical_slug: "anthropic/claude-5-fable-20260609",
              name: "Anthropic: Claude Fable 5",
              created: 1781007515,
              architecture: {
                input_modalities: ["text", "image", "file"],
                output_modalities: ["text"],
              },
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };
    globalThis.fetch = mockFetch as typeof fetch;

    const resolved = await resolveModel("anthropic/claude-fable-5");

    expect(resolved.discovered).toBe(true);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.openRouterFirstSeenAt).toBe(1781007515000);
    expect(resolved.inputModalities).toEqual(["text", "image", "file"]);
    expect(resolved.outputModalities).toEqual(["text"]);
    expect(resolved.model.formattedName).toBe("Anthropic: Claude Fable 5");
    expect(resolved.model.runnableName).toBe("anthropic/claude-fable-5");
  });
});

describe("preflightOpenRouterEndpoint", () => {
  it("requests at least the OpenAI minimum output token count", async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      requestBody = JSON.parse(init.body);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await preflightOpenRouterEndpoint(
      {
        name: "openai/gpt-5.6-sol",
        runnableName: "openai/gpt-5.6-sol",
        formattedName: "OpenAI: GPT-5.6 Sol",
        baseURL: "https://openrouter.ai/api/v1",
        apiKind: "chat",
      },
      "test-api-key",
    );

    expect(requestBody).toMatchObject({ max_tokens: 16 });
    expect(requestBody).not.toHaveProperty("temperature");
  });

  it("retries transient rate limits", async () => {
    let requestCount = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      requestCount++;
      if (requestCount === 1) {
        return Response.json(
          { error: { message: "Provider returned error" } },
          { status: 429, headers: { "Retry-After": "0" } },
        );
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await preflightOpenRouterEndpoint(
      {
        name: "moonshotai/kimi-k3",
        runnableName: "moonshotai/kimi-k3",
        formattedName: "MoonshotAI: Kimi K3",
        baseURL: "https://openrouter.ai/api/v1",
        apiKind: "chat",
      },
      "test-api-key",
    );

    expect(requestCount).toBe(2);
  });
});
