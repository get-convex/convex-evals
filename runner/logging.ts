/**
 * Logging utilities for evaluation runs.
 */
import { appendFileSync, readFileSync } from "fs";

/** Remove ANSI escape codes from text. */
export function sanitizeOutput(text: string): string {
  try {
    return text
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "") // CSI sequences
      .replace(/\x1B\][^\x07]*\x07/g, "") // OSC sequences (BEL)
      .replace(/\x1B\]8;;.*?\x1B\\/g, "") // OSC 8 hyperlinks
      .replace(/\x1B[@-Z\\-_]/g, ""); // 7-bit C1
  } catch {
    return text;
  }
}

/** Append a line to a log file. */
export function appendLog(logPath: string, text: string): void {
  try {
    const sanitized = sanitizeOutput(text);
    appendFileSync(
      logPath,
      sanitized.endsWith("\n") ? sanitized : sanitized + "\n",
      "utf-8",
    );
  } catch {
    // Best-effort logging
  }
}

/** Append a block of content to a log file with a prefix on each line. */
export function appendLogBlock(
  logPath: string,
  prefix: string,
  content: string | null,
): void {
  if (!content) return;
  for (const line of sanitizeOutput(content).split("\n")) {
    appendLog(logPath, `[${prefix}] ${line}`);
  }
}

/** Log command results to a file. */
export function logCmdResults(
  logPath: string,
  results: Array<{ cmd: string; stdout: string }>,
  prefix: string,
  cmdPrefix = "",
): void {
  for (const { cmd, stdout } of results) {
    appendLog(logPath, `[cmd] ${cmdPrefix}${cmd}`);
    appendLogBlock(logPath, prefix, stdout);
  }
}

/** Print an info message to stdout. */
export function logInfo(message: string): void {
  console.log(message);
}

/** Surface the diagnostic tail in CI while the artifact retains the full log. */
export function logFailureDetails(logPath: string): void {
  logInfo(`Full grader log: ${logPath}`);
  try {
    const content = sanitizeOutput(readFileSync(logPath, "utf8"));
    logInfo(content.slice(-12_000));
  } catch {
    // Missing diagnostics must not replace the original validation failure.
    logInfo("Grader log unavailable.");
  }
}

/** Log vitest results to a file. */
export function logVitestResults(
  logPath: string,
  cmd: string,
  stdout: string,
): void {
  appendLog(logPath, `[cmd] ${cmd}`);
  appendLogBlock(logPath, "vitest", stdout);
}

/**
 * Execute a handler that returns command results; log results or error.
 * Returns the success flag and captured error string on failure.
 */
export async function runCommandStep(
  logPath: string,
  handler: () => Promise<Array<{ cmd: string; stdout: string }>>,
  prefix: string,
  errorLabel: string,
  cmdPrefix = "",
): Promise<{ passed: boolean; error?: string }> {
  try {
    const results = await handler();
    logCmdResults(logPath, results, prefix, cmdPrefix);
    return { passed: true };
  } catch (e) {
    const error = String(e);
    appendLog(logPath, `[error] ${errorLabel}: ${error}`);
    return { passed: false, error };
  }
}
