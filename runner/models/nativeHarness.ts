import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { LanguageModelUsage } from "ai";

export type NativeHarnessName = "codex" | "claude" | "grok";

export type NativeHarnessConfig = {
  name: NativeHarnessName;
  webSearch: boolean;
};

type NativeHarnessResult = {
  files: Record<string, string>;
  usage?: LanguageModelUsage;
  rawResponse: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

const IGNORED_OUTPUT_NAMES = new Set([
  ".claude",
  ".codex",
  ".git",
  ".grok",
  "bun.lock",
  "node_modules",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function nativeModelName(
  harness: NativeHarnessName,
  modelName: string,
): string {
  const mappings: Record<NativeHarnessName, Record<string, string>> = {
    codex: {
      "openai/gpt-5.6-sol": "gpt-5.6-sol",
      "openai/gpt-5.6-luna": "gpt-5.6-luna",
    },
    claude: {
      "anthropic/claude-opus-5": "claude-opus-5",
      "anthropic/claude-sonnet-5": "claude-sonnet-5",
    },
    grok: {
      "x-ai/grok-4.6": "grok-4.6",
      "x-ai/grok-4.5": "grok-4.5",
    },
  };

  const resolved = mappings[harness][modelName];
  if (!resolved) {
    throw new Error(
      `Model ${modelName} is not configured for the ${harness} native harness`,
    );
  }
  return resolved;
}

export function buildNativeHarnessInvocation(
  config: NativeHarnessConfig,
  modelName: string,
  workspace: string,
  prompt: string,
): { command: string; args: string[] } {
  const model = nativeModelName(config.name, modelName);

  if (config.name === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--json",
        "--model",
        model,
        "--cd",
        workspace,
        "--sandbox",
        "workspace-write",
        "--config",
        'approval_policy="never"',
        "--config",
        "sandbox_workspace_write.network_access=false",
        "--config",
        `web_search="${config.webSearch ? "live" : "disabled"}"`,
        "--config",
        `tools.web_search=${config.webSearch}`,
        prompt,
      ],
    };
  }

  if (config.name === "claude") {
    const permissions = config.webSearch
      ? {
          allow: [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch(domain:*)",
          ],
          deny: ["Agent"],
        }
      : {
          allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
          deny: ["Agent", "WebSearch", "WebFetch"],
        };
    const settings = JSON.stringify({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains: [],
          strictAllowlist: true,
        },
      },
      permissions,
    });

    return {
      command: "claude",
      args: [
        "--print",
        "--safe-mode",
        "--model",
        model,
        "--effort",
        "medium",
        "--permission-mode",
        "acceptEdits",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--settings",
        settings,
        prompt,
      ],
    };
  }

  return {
    command: "grok",
    args: [
      "--single",
      prompt,
      "--model",
      model,
      "--reasoning-effort",
      "medium",
      "--output-format",
      "json",
      "--sandbox",
      "strict",
      "--no-subagents",
      "--always-approve",
      "--max-turns",
      "30",
      ...(config.webSearch ? [] : ["--disable-web-search"]),
    ],
  };
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const timeoutMs = Number(
    process.env.NATIVE_HARNESS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let capturedBytes = 0;
  let timedOut = false;

  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    capturedBytes += chunk.length;
    if (capturedBytes > MAX_CAPTURE_BYTES) {
      child.kill("SIGTERM");
      return;
    }
    target.push(chunk);
  };

  child.stdout.on("data", capture(stdoutChunks));
  child.stderr.on("data", capture(stderrChunks));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (timedOut) {
    throw new Error(
      `${command} timed out after ${timeoutMs}ms\n${stderr || stdout}`,
    );
  }
  if (capturedBytes > MAX_CAPTURE_BYTES) {
    throw new Error(
      `${command} exceeded the ${MAX_CAPTURE_BYTES} byte log cap`,
    );
  }

  return { stdout, stderr, exitCode };
}

function collectWorkspaceFiles(workspace: string): Record<string, string> {
  const files: Record<string, string> = {};

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_OUTPUT_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = relative(workspace, path).split(sep).join("/");
      files[relativePath] = readFileSync(path, "utf8");
    }
  }

  walk(workspace);
  return files;
}

function usage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  totalTokens: number | undefined,
  raw: Record<string, unknown>,
): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens,
    raw: raw as NonNullable<LanguageModelUsage["raw"]>,
  };
}

function parseCodexUsage(stdout: string): LanguageModelUsage | undefined {
  let finalUsage: Record<string, unknown> | undefined;
  let webSearchRequestCount = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      if (event.type === "item.completed" && item?.type === "web_search") {
        webSearchRequestCount++;
      }
      if (event.type === "turn.completed") {
        finalUsage = event.usage as Record<string, unknown> | undefined;
      }
    } catch {
      // Keep parsing other JSONL events. The raw transcript is retained.
    }
  }

  if (!finalUsage) return undefined;
  return usage(
    numberValue(finalUsage.input_tokens),
    numberValue(finalUsage.output_tokens),
    undefined,
    {
      harness: "codex",
      webSearchRequestCount,
      cachedInputTokens: numberValue(finalUsage.cached_input_tokens),
      reasoningOutputTokens: numberValue(finalUsage.reasoning_output_tokens),
    },
  );
}

function parseClaudeUsage(stdout: string): LanguageModelUsage | undefined {
  const result = parseJsonObject(stdout);
  const rawUsage = objectValue(result.usage);
  if (!rawUsage) return undefined;

  const modelUsage = objectValue(result.modelUsage);
  let webSearchRequestCount = 0;
  if (modelUsage) {
    for (const value of Object.values(modelUsage)) {
      const perModel = objectValue(value);
      webSearchRequestCount += numberValue(perModel?.webSearchRequests) ?? 0;
    }
  } else {
    const serverToolUse = objectValue(rawUsage.server_tool_use);
    webSearchRequestCount =
      numberValue(serverToolUse?.web_search_requests) ?? 0;
  }

  return usage(
    numberValue(rawUsage.input_tokens),
    numberValue(rawUsage.output_tokens),
    undefined,
    {
      harness: "claude",
      webSearchRequestCount,
      webFetchRequestCount:
        numberValue(
          objectValue(rawUsage.server_tool_use)?.web_fetch_requests,
        ) ?? 0,
      cost: numberValue(result.total_cost_usd),
      numTurns: numberValue(result.num_turns),
    },
  );
}

function parseGrokUsage(stdout: string): LanguageModelUsage | undefined {
  const result = parseJsonObject(stdout);
  const rawUsage = objectValue(result.usage);
  if (!rawUsage) return undefined;
  const serverToolUse = objectValue(rawUsage.server_tool_use);

  return usage(
    numberValue(rawUsage.input_tokens),
    numberValue(rawUsage.output_tokens),
    numberValue(rawUsage.total_tokens),
    {
      harness: "grok",
      webSearchRequestCount:
        numberValue(serverToolUse?.web_search_requests) ?? 0,
      cost: numberValue(result.total_cost_usd),
      numTurns: numberValue(result.num_turns),
    },
  );
}

export function parseNativeHarnessUsage(
  harness: NativeHarnessName,
  stdout: string,
): LanguageModelUsage | undefined {
  if (harness === "codex") return parseCodexUsage(stdout);
  if (harness === "claude") return parseClaudeUsage(stdout);
  return parseGrokUsage(stdout);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native harness did not return a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export async function generateWithNativeHarness({
  config,
  modelName,
  prompt,
}: {
  config: NativeHarnessConfig;
  modelName: string;
  prompt: string;
}): Promise<NativeHarnessResult> {
  const workspace = mkdtempSync(join(tmpdir(), `convex-${config.name}-eval-`));
  const keepWorkspace = process.env.NATIVE_HARNESS_KEEP_WORKSPACE === "1";

  try {
    const invocation = buildNativeHarnessInvocation(
      config,
      modelName,
      workspace,
      prompt,
    );
    const startedAt = Date.now();
    const result = await runCommand(
      invocation.command,
      invocation.args,
      workspace,
    );
    const harnessDurationMs = Date.now() - startedAt;
    const rawResponse = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");

    if (result.exitCode !== 0) {
      throw new Error(
        `${config.name} exited with code ${result.exitCode}\n${rawResponse}`,
      );
    }

    const parsedUsage = parseNativeHarnessUsage(config.name, result.stdout);
    if (parsedUsage) {
      parsedUsage.raw = {
        ...(parsedUsage.raw ?? {}),
        harnessDurationMs,
      };
    }

    return {
      files: collectWorkspaceFiles(workspace),
      usage: parsedUsage,
      rawResponse,
    };
  } finally {
    if (!keepWorkspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
