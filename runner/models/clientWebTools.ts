import type { JSONValue } from "ai";
/** Client-owned Exa execution with durable per-invocation accounting. */
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";

export function jsonRecord(value: unknown): Record<string, JSONValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JSONValue>)
    : {};
}

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type Event = Record<string, unknown> & { kind: string };
export type Journal = (event: Event) => void;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createJournal(path: string, secrets: string[] = []): Journal {
  mkdirSync(dirname(path), { recursive: true });
  // Never append a new pilot to an old file or accidentally overwrite evidence.
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  return (event) => {
    let line =
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    for (const secret of secrets.filter(Boolean))
      line = line.replaceAll(secret, "[redacted]");
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}

export const clientTools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for information. Returns URLs, titles, and relevant excerpts.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Read the contents of a public web page at a given URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

export function summarizeToolEvents(events: Event[]) {
  const requests = events.filter((e) => e.kind === "tool_requested");
  const prepared = events.filter((e) => e.kind === "dispatch_prepared");
  const terminal = events.filter((e) => e.kind === "tool_result");
  const batchRejected = events
    .filter((e) => e.kind === "tool_batch_rejected")
    .reduce((sum, e) => sum + Number(e.count), 0);
  return {
    requestedCalls: requests.length + batchRejected,
    searchAttempts: prepared.filter((e) => e.tool === "web_search").length,
    fetchAttempts: prepared.filter((e) => e.tool === "web_fetch").length,
    successfulCalls: terminal.filter((e) => e.outcome === "success").length,
    failedCalls: terminal.filter((e) => e.outcome === "failed").length,
    rejectedCalls:
      terminal.filter((e) => e.outcome === "rejected").length + batchRejected,
    unknownOutcomes: terminal.filter((e) => e.outcome === "unknown").length,
    // A process can die between persisting intent and sending a request. Such a
    // record is incomplete, never silently counted as a successful execution.
    incompleteAttempts: prepared.filter(
      (e) => !terminal.some((t) => t.invocation === e.invocation),
    ).length,
  };
}

export async function readBoundedJson(
  response: Response,
  maxBytes = 2_000_000,
): Promise<JSONValue> {
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error("Response exceeds byte budget");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JSONValue;
}

export class ClientWebTools {
  private invocation = 0;
  private seen = new Set<string>();
  private attempts = { web_search: 0, web_fetch: 0 };
  private events: Event[] = [];

  constructor(
    private readonly options: {
      exaKey: string;
      journal: Journal;
      fetch?: Fetch;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) {}

  private record(event: Event) {
    // Persist first. A failed journal write must stop execution.
    this.options.journal(event);
    this.events.push(event);
  }

  summary() {
    return summarizeToolEvents(this.events);
  }

  rejectCalls(calls: unknown[], error: string) {
    // One bounded journal append even for an oversized batch. No dispatches.
    this.record({
      kind: "tool_batch_rejected",
      count: calls.length,
      calls,
      error,
    });
  }

  async execute(call: ToolCall): Promise<string> {
    const invocation = ++this.invocation;
    const tool = call.function.name;
    this.record({ kind: "tool_requested", invocation, call });
    const reject = (error: string) => {
      const result = { error };
      this.record({
        kind: "tool_result",
        invocation,
        tool,
        outcome: "rejected",
        result,
      });
      return JSON.stringify(result);
    };
    if (!call.id || this.seen.has(call.id))
      return reject("Missing or duplicate tool-call ID");
    this.seen.add(call.id);
    if (tool !== "web_search" && tool !== "web_fetch")
      return reject("Unknown tool");
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return reject("Invalid JSON arguments");
    }
    const key = tool === "web_search" ? "query" : "url";
    if (
      !args ||
      Array.isArray(args) ||
      Object.keys(args).length !== 1 ||
      typeof args[key] !== "string" ||
      !args[key].trim() ||
      args[key].length > 2000
    ) {
      return reject(
        `Expected one nonempty ${key} string, at most 2000 characters`,
      );
    }
    if (tool === "web_fetch") {
      try {
        const url = new URL(args.url as string);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password)
          return reject("Expected a public HTTP(S) URL without credentials");
      } catch {
        return reject("Invalid URL");
      }
    }
    const total = this.attempts.web_search + this.attempts.web_fetch;
    if (total >= 6 || this.attempts[tool] >= 5)
      return reject("Tool request budget exhausted");
    if (!this.options.exaKey) return reject("EXA_API_KEY is required");
    if (this.options.signal?.aborted) return reject("Pilot was aborted");
    const endpoint = tool === "web_search" ? "search" : "contents";
    const body =
      tool === "web_search"
        ? {
            query: args.query,
            type: "auto",
            numResults: 5,
            contents: { highlights: { maxCharacters: 1500 } },
          }
        : { urls: [args.url], text: { maxCharacters: 30000 } };
    this.record({
      kind: "dispatch_prepared",
      invocation,
      tool,
      endpoint,
      body,
    });
    this.attempts[tool]++;
    let response: Response;
    let data: Record<string, JSONValue> = {};
    try {
      // No hidden retries. If the model retries, that is a separate recorded call.
      response = await (this.options.fetch ?? globalThis.fetch)(
        `https://api.exa.ai/${endpoint}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.options.exaKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            AbortSignal.timeout(this.options.timeoutMs ?? 30000),
            ...(this.options.signal ? [this.options.signal] : []),
          ]),
        },
      );
    } catch (error) {
      // We know the runner attempted a request. We cannot know whether the
      // remote service executed it before a socket failure or timeout.
      const result = {
        error: "Search service response unavailable",
        detail: String(error),
      };
      this.record({
        kind: "tool_result",
        invocation,
        tool,
        outcome: "unknown",
        result,
      });
      return JSON.stringify(result);
    }
    let valid = false;
    let result: unknown;
    try {
      data = jsonRecord(await readBoundedJson(response));
      const results = Array.isArray(data.results)
        ? data.results.map(jsonRecord)
        : [];
      valid =
        response.ok &&
        Array.isArray(data?.results) &&
        results.every(
          (r) =>
            r &&
            typeof r.url === "string" &&
            (r.highlights == null ||
              (Array.isArray(r.highlights) &&
                r.highlights.every((h: unknown) => typeof h === "string"))),
        ) &&
        (tool === "web_search" ||
          results.some((r) => typeof r.text === "string" && r.text.length > 0));
      result = valid
        ? {
            results: results
              .slice(0, tool === "web_search" ? 5 : 1)
              .map((r) => ({
                url: r.url,
                title:
                  typeof r.title === "string"
                    ? r.title.slice(0, 1000)
                    : undefined,
                ...(tool === "web_search"
                  ? {
                      excerpts: (Array.isArray(r.highlights)
                        ? r.highlights.filter(
                            (h): h is string => typeof h === "string",
                          )
                        : []
                      )
                        .join("\n")
                        .slice(0, 1500),
                    }
                  : {
                      text: decode(
                        encode(typeof r.text === "string" ? r.text : "", {
                          disallowedSpecial: new Set(),
                        }).slice(0, 5000),
                      ),
                    }),
              })),
          }
        : {
            error: "Search service returned an error",
            status: response.status,
            statuses: data?.statuses,
          };
    } catch (error) {
      valid = false;
      result = {
        error: "Search service returned an unusable response",
        detail: String(error),
      };
    }
    this.record({
      kind: "tool_result",
      invocation,
      tool,
      outcome: valid ? "success" : "failed",
      httpStatus: response.status,
      providerRequestId: data?.requestId,
      costDollars: data?.costDollars,
      rawResponse: data,
      result,
    });
    return JSON.stringify(result);
  }
}
