import { anthropic } from '@ai-sdk/anthropic';
import { generateText, Output } from 'ai';
import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import type { FailureAnalysis, EvalResult } from './types.js';

const analysisSchema = z.object({
  analysis: z.string().describe('Detailed explanation of what went wrong and why'),
  suggestedGuideline: z.string().describe('A specific, actionable guideline to prevent this failure'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Confidence level in this analysis'),
  relatedLegacyGuidelines: z.array(z.string()).describe('Related snippets from legacy guidelines'),
});

const CONVEX_DOCS_DOMAINS = ['docs.convex.dev', 'stack.convex.dev'];

// Use latest Claude Sonnet model
const MODEL_ID = 'claude-sonnet-4-5-20250929';

// Timeout for LLM analysis (5 minutes) - includes potential web search
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

// Max retries for structured output parsing failures
const MAX_RETRIES = 3;

export async function analyzeFailure(
  evalResult: EvalResult,
  legacyGuidelines: string
): Promise<FailureAnalysis> {
  // Gather context
  const taskContent = existsSync(evalResult.taskPath)
    ? readFileSync(evalResult.taskPath, 'utf-8')
    : 'Task file not found';

  const expectedContent = evalResult.expectedFiles
    .map(file => {
      if (!existsSync(file)) return `${file}: File not found`;
      const content = readFileSync(file, 'utf-8');
      return `=== ${file} ===\n${content}`;
    })
    .join('\n\n');

  const outputContent = evalResult.outputFiles
    .map(file => {
      if (!existsSync(file)) return `${file}: File not found`;
      const content = readFileSync(file, 'utf-8');
      return `=== ${file} ===\n${content}`;
    })
    .join('\n\n');

  const runLog = existsSync(evalResult.runLogPath)
    ? readFileSync(evalResult.runLogPath, 'utf-8')
    : 'Run log not found';

  // Web search tool for Convex docs lookup
  const webSearchTool = anthropic.tools.webSearch_20250305({
    maxUses: 3,
    allowedDomains: CONVEX_DOCS_DOMAINS,
  });

  const prompt = `You are a failure analysis agent for Convex code generation evals.

Your task is to analyze why a specific eval failed and suggest a guideline that would prevent this failure in the future.

## Eval: ${evalResult.evalName}

### Task
${taskContent}

### Expected Output
${expectedContent}

### Actual Output
${outputContent}

### Run Log
${runLog}

### Legacy Guidelines for Reference
${legacyGuidelines}

## Your Task

1. If you need to look up Convex-specific APIs or patterns, use web search to check the official Convex docs
2. Identify what went wrong - be specific about the mistake
3. Suggest a guideline that would prevent this specific mistake
4. Check if any legacy guidelines are related to this issue
5. Rate your confidence in this analysis

Guidelines should be:
- Specific and actionable
- Focused on one concept
- Include examples when helpful
- 50-100 tokens each
- Not redundant with existing guidelines`;

  // Retry loop for structured output failures
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), ANALYSIS_TIMEOUT_MS);

    try {
      const { output } = await generateText({
        model: anthropic(MODEL_ID),
        output: Output.object({ schema: analysisSchema }),
        prompt,
        tools: { web_search: webSearchTool },
        abortSignal: abortController.signal,
      });

      if (!output) {
        lastError = new Error(`No output generated on attempt ${attempt}`);
        continue;
      }

      return {
        analysis: output.analysis,
        suggestedGuideline: output.suggestedGuideline,
        confidence: output.confidence,
        relatedLegacyGuidelines: output.relatedLegacyGuidelines,
      };
    } catch (error) {
      clearTimeout(timeout);
      
      if (abortController.signal.aborted) {
        lastError = new Error(`Analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s`);
        break; // Don't retry timeouts
      }
      
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Only retry on parsing errors, not other failures
      const isParsingError = String(error).includes('NoObjectGenerated') || 
                             String(error).includes('could not parse');
      if (!isParsingError) break;
      
      console.warn(`[${evalResult.evalName}] Retry ${attempt}/${MAX_RETRIES} after parsing error`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Return a low-confidence fallback analysis instead of crashing
  console.warn(`[${evalResult.evalName}] All retries failed, returning fallback analysis`);
  return {
    analysis: `Analysis failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? 'Unknown error'}. Manual review recommended for eval: ${evalResult.evalName}`,
    suggestedGuideline: `Review and fix the issue in eval ${evalResult.evalName} - automatic analysis could not determine the root cause.`,
    confidence: 'low',
    relatedLegacyGuidelines: [],
  };
}
