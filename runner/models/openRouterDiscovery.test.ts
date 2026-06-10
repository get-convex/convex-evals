import { afterEach, describe, expect, it } from "bun:test";
import { resolveModel } from "./openRouterDiscovery.js";

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
