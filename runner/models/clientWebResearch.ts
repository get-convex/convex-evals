import type { LanguageModelUsage } from "ai";
import { WEB_SOURCE_POLICY } from "./webSourcePolicy";
import { InfrastructureError } from "../convexBackend";
import { runClientWebLoop } from "./clientWebLoop";
import {
  createJournal,
  jsonRecord,
  type Event,
  type Journal,
} from "./clientWebTools";

// Local pilots never publish. Production reporting requires the reviewed main
// workflow and a separate rollout switch, so merging alone cannot start web runs.
export function validateClientWebRun(experiment: string | undefined) {
  if (process.env.CLIENT_WEB_TOOLS !== "1") {
    if (
      experiment === "no_guidelines_with_web" &&
      process.env.DISABLE_CONVEX_REPORTING !== "1"
    )
      throw new Error("Published web runs require CLIENT_WEB_TOOLS=1");
    return;
  }
  if (experiment !== "no_guidelines_with_web")
    throw new Error("CLIENT_WEB_TOOLS requires no_guidelines_with_web");
  const approvedProduction =
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REF === "refs/heads/main" &&
    process.env.ENABLE_CLIENT_WEB_PRODUCTION === "true";
  if (process.env.DISABLE_CONVEX_REPORTING !== "1" && !approvedProduction)
    throw new Error(
      "Client web requires DISABLE_CONVEX_REPORTING=1 or explicitly enabled main-branch Actions",
    );
  if (!process.env.EXA_API_KEY) throw new Error("EXA_API_KEY is required");
}

export async function generateWithClientWeb(options: {
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  apiKey: string;
  sessionId: string;
  tracePath: string;
}) {
  validateClientWebRun(process.env.EVALS_EXPERIMENT);
  const events: Event[] = [];
  const secrets = [options.apiKey, process.env.EXA_API_KEY!];
  let journal: Journal = () => {};
  try {
    journal = createJournal(options.tracePath, secrets);
    const result = await runClientWebLoop({
      ...options,
      purpose: "eval-generation",
      openrouterKey: options.apiKey,
      exaKey: process.env.EXA_API_KEY!,
      journal: (event) => {
        journal(event);
        events.push(event);
      },
    });
    if (!result.text.trim() && result.modelOutcome === "completed")
      throw new Error("Empty final answer");
    if (result.summary.unknownOutcomes || result.summary.incompleteAttempts)
      throw new Error(
        "Unresolved tool outcome; exclude this eval from scored results",
      );
    const usages = result.usage.map(jsonRecord);
    const sum = (field: string): number | undefined => {
      const values = usages.map((u) => u[field]);
      return values.every(
        (v): v is number => typeof v === "number" && Number.isFinite(v),
      )
        ? values.reduce((total, v) => total + v, 0)
        : undefined;
    };
    const toolResults = events.filter(
      (e) => e.kind === "tool_result" && e.outcome !== "rejected",
    );
    const toolCosts = toolResults.map(
      (e) => (e.costDollars as { total?: number } | undefined)?.total,
    );
    const exaCost = toolCosts.every(
      (c) => typeof c === "number" && Number.isFinite(c),
    )
      ? toolCosts.reduce<number>((total, c) => total + c!, 0)
      : undefined;
    const modelCost = sum("cost");
    const cost =
      modelCost !== undefined && exaCost !== undefined
        ? modelCost + exaCost
        : undefined;
    const ids = events
      .filter((e) => e.kind === "model_response")
      .map((e) => jsonRecord(e.data).id)
      .filter((id) => typeof id === "string");
    const usage: LanguageModelUsage = {
      inputTokens: sum("prompt_tokens"),
      outputTokens: sum("completion_tokens"),
      totalTokens: sum("total_tokens"),
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      raw: {
        ...(cost !== undefined ? { cost } : {}),
        // The existing leaderboard reducer already accepts explicit counters
        // here. This includes observed zero, without its legacy zero inference.
        webResearch: {
          searchRequests: result.summary.searchAttempts,
          fetchRequests: result.summary.fetchAttempts,
          searchEngine: "exa",
          fetchEngine: "exa",
          countSource: "client-dispatched",
          tracePath: options.tracePath,
        },
        clientWeb: {
          profile: "client-exa-v1",
          sourcePolicy: WEB_SOURCE_POLICY,
          ...result.summary,
          tracePath: options.tracePath,
          modelCost,
          exaCost,
          knownModelCost: usages.reduce(
            (total, u) =>
              total +
              (typeof u?.cost === "number" && Number.isFinite(u.cost)
                ? u.cost
                : 0),
            0,
          ),
          knownExaCost: toolCosts.reduce<number>(
            (total, c) =>
              total + (typeof c === "number" && Number.isFinite(c) ? c : 0),
            0,
          ),
          costComplete: cost !== undefined,
          modelTurns: result.turns,
          modelOutcome: result.modelOutcome,
          generationIds: ids,
          // Preserve every turn's usage for auditing token/cache details.
          modelUsage: usages.map((u) => u ?? null),
        },
      },
    };
    journal({ kind: "generation_usage", usage });
    return {
      text: result.text,
      usage,
      openRouterGenerationId: ids.at(-1),
    };
  } catch (error) {
    let message = String(error);
    for (const secret of secrets.filter(Boolean))
      message = message.replaceAll(secret, "[redacted]");
    try {
      journal({ kind: "generation_failed", error: message });
    } catch {
      /* Preserve the original failure if the journal itself failed. */
    }
    // Do not let the runner retry the entire paid tool loop or grade an
    // interrupted generation as a model failure. The journal retains evidence.
    throw new InfrastructureError(
      `Client web generation failed; trace ${options.tracePath}: ${message}`,
    );
  }
}
