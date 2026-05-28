import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";

const stdinChunks = [];
for await (const chunk of process.stdin) stdinChunks.push(chunk);
const input = JSON.parse(Buffer.concat(stdinChunks).toString("utf8"));

const {
  runnableName,
  formattedName,
  userPrompt,
  workspacePath,
  maxTurns = 50,
  maxWallMs = 10 * 60 * 1000,
} = input;

mkdirSync(join(workspacePath, "convex"), { recursive: true });
writeFileSync(
  join(workspacePath, "package.json"),
  JSON.stringify(
    {
      name: "convex-eval-workspace",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { convex: "^1.31.2" },
      devDependencies: { typescript: "^5.7.3" },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(workspacePath, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        esModuleInterop: true,
        isolatedModules: true,
      },
      include: ["convex/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);

const abortController = new AbortController();
const wallTimer = setTimeout(() => abortController.abort(), maxWallMs);

const requestStartedAt = Date.now();
let timeToFirstTokenMs;
const assistantTextChunks = [];
const toolCallCounts = {};
let resultMessage;
let assistantError;

try {
  const q = query({
    prompt: userPrompt,
    options: {
      cwd: workspacePath,
      model: runnableName,
      abortController,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
    },
  });

  for await (const message of q) {
    if (message.type === "assistant") {
      if (timeToFirstTokenMs === undefined) {
        timeToFirstTokenMs = Date.now() - requestStartedAt;
      }
      if (message.error) {
        assistantError = message.error;
      }
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          assistantTextChunks.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          toolCallCounts[block.name] = (toolCallCounts[block.name] ?? 0) + 1;
        }
      }
    } else if (message.type === "result") {
      resultMessage = message;
      if (message.subtype === "success" && message.ttft_ms !== undefined) {
        timeToFirstTokenMs = message.ttft_ms;
      }
      if (
        message.num_turns !== undefined &&
        message.num_turns >= maxTurns
      ) {
        abortController.abort();
      }
    }
  }
} finally {
  clearTimeout(wallTimer);
}

process.stderr.write(
  `[claude-code] ${formattedName} done: subtype=${resultMessage?.subtype ?? "none"} turns=${resultMessage?.num_turns ?? "?"} stop=${resultMessage?.stop_reason ?? "?"} tools=${JSON.stringify(toolCallCounts)} text=${assistantTextChunks.join("").length}ch\n`,
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".convex",
  "_generated",
  ".git",
]);
const ALLOWED_ROOT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
]);

function walk(dir, base, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(/\\|\//).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (rel === "" || rel.startsWith("convex")) {
        walk(full, base, files);
      }
      // Skip any other top-level dirs the agent may have created
    } else if (entry.isFile()) {
      const isInConvex = rel.startsWith("convex/");
      const isAllowedRoot =
        !rel.includes("/") && ALLOWED_ROOT_FILES.has(rel);
      if (!isInConvex && !isAllowedRoot) continue;
      try {
        files[rel] = readFileSync(full, "utf8");
      } catch {
        // ignore binary / unreadable files
      }
    }
  }
}

const files = {};
walk(workspacePath, workspacePath, files);

const ok = resultMessage?.subtype === "success" && !assistantError;
const cost =
  typeof resultMessage?.total_cost_usd === "number"
    ? resultMessage.total_cost_usd
    : null;

const usage = resultMessage?.usage
  ? {
      inputTokens: resultMessage.usage.input_tokens,
      outputTokens: resultMessage.usage.output_tokens,
      totalTokens:
        (resultMessage.usage.input_tokens ?? 0) +
        (resultMessage.usage.output_tokens ?? 0),
      raw: {
        cost,
        timeToFirstTokenMs,
        numTurns: resultMessage.num_turns,
        stopReason: resultMessage.stop_reason,
        terminalReason: resultMessage.terminal_reason,
        toolCallCounts,
        assistantError,
        formattedName,
        ...resultMessage.usage,
      },
    }
  : undefined;

const output = {
  ok,
  files,
  usage,
  rawResponse: assistantTextChunks.join("\n"),
  timeToFirstTokenMs,
  numTurns: resultMessage?.num_turns,
  stopReason: resultMessage?.stop_reason,
  resultSubtype: resultMessage?.subtype,
  assistantError,
};

process.stdout.write(JSON.stringify(output));
