import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class Logger {
  private detailedLogPath: string;

  constructor(private logPath: string) {
    // Create a detailed log file alongside the main log
    this.detailedLogPath = logPath.replace('.log', '_detailed.log');
    // Ensure directory exists
    mkdirSync(dirname(logPath), { recursive: true });
  }

  /**
   * Log to console (terse) and file (full)
   */
  log(
    level: 'info' | 'debug' | 'step' | 'warn' | 'error' | 'tool' | 'subagent',
    message: string,
    data?: object
  ) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    // Console: terse output
    console.log(line);
    if (data && level !== 'debug') {
      // Only show truncated data on console for non-debug
      const dataStr = JSON.stringify(data, null, 2);
      if (dataStr.length > 300) {
        console.log(dataStr.slice(0, 300) + '...');
      } else {
        console.log(dataStr);
      }
    }

    // File: full output
    appendFileSync(this.logPath, line + '\n');
    if (data) appendFileSync(this.logPath, JSON.stringify(data, null, 2) + '\n');
  }

  /**
   * Log detailed information only to file (not console)
   */
  detailed(message: string, data?: unknown) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    appendFileSync(this.detailedLogPath, line + '\n');
    if (data !== undefined) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      appendFileSync(this.detailedLogPath, dataStr + '\n');
    }
  }

  info(message: string, data?: object) {
    this.log('info', message, data);
  }

  debug(message: string, data?: object) {
    this.log('debug', message, data);
  }

  step(message: string, data?: object) {
    this.log('step', message, data);
  }

  warn(message: string, data?: object) {
    this.log('warn', message, data);
  }

  error(message: string, data?: object) {
    this.log('error', message, data);
  }

  /**
   * Log tool calls (shown in console)
   */
  tool(toolName: string, input?: object) {
    this.log('tool', `→ ${toolName}`, input);
  }

  /**
   * Log subagent invocation (shown in console)
   */
  subagent(agentName: string, status: 'start' | 'complete' | 'failed', summary?: string) {
    const icon = status === 'start' ? '🤖' : status === 'complete' ? '✓' : '✗';
    this.log('subagent', `${icon} ${agentName} ${status}${summary ? `: ${summary}` : ''}`);
  }

  /**
   * Log tool progress (shown in console)
   */
  toolProgress(toolName: string, elapsedSeconds: number) {
    console.log(`  ⏱ ${toolName} running... (${elapsedSeconds.toFixed(1)}s)`);
    this.detailed(`Tool progress: ${toolName} (${elapsedSeconds.toFixed(1)}s)`);
  }

  /**
   * Log token usage (shown in console)
   * @param totalInputTokens - Total input tokens (non-cached + cache read + cache creation)
   * @param outputTokens - Output tokens generated
   * @param cacheReadTokens - Tokens read from cache
   * @param cacheCreationTokens - Tokens written to cache
   */
  tokens(
    totalInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number
  ) {
    // Claude Opus context window is 200K tokens
    const contextWindow = 200000;
    const totalContext = totalInputTokens + outputTokens;
    const contextPercent = ((totalContext / contextWindow) * 100).toFixed(1);
    const cacheHitPercent =
      totalInputTokens > 0 ? ((cacheReadTokens / totalInputTokens) * 100).toFixed(0) : '0';

    const line = `  📊 Context: ${totalContext.toLocaleString()}/${contextWindow.toLocaleString()} (${contextPercent}%) | In: ${totalInputTokens.toLocaleString()} Out: ${outputTokens.toLocaleString()} | Cache hit: ${cacheHitPercent}%`;
    console.log(line);
    this.detailed(line);
  }

  /**
   * Log final result summary
   */
  result(
    totalCostUsd: number,
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>,
    numTurns: number
  ) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📈 Final Summary: ${numTurns} turns | Cost: $${totalCostUsd.toFixed(4)}`);

    for (const [model, usage] of Object.entries(modelUsage)) {
      const totalTokens = usage.inputTokens + usage.outputTokens;
      const contextPercent = ((totalTokens / usage.contextWindow) * 100).toFixed(1);
      console.log(
        `   ${model}: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out (${contextPercent}% context) | $${usage.costUSD.toFixed(4)}`
      );
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    this.detailed('Final result', { totalCostUsd, modelUsage, numTurns });
  }
}
