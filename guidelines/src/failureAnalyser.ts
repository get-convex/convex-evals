import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import type { FailureAnalysis, EvalResult } from './types.js';

const analysisSchema = z.object({
  analysis: z.string(),
  suggestedGuideline: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  relatedLegacyGuidelines: z.array(z.string()),
});

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

1. Identify what went wrong - be specific about the mistake
2. Suggest a guideline that would prevent this specific mistake
3. Check if any legacy guidelines are related to this issue
4. Rate your confidence in this analysis

Guidelines should be:
- Specific and actionable
- Focused on one concept
- Include examples when helpful
- 50-100 tokens each
- Not redundant with existing guidelines

Return your analysis in this JSON format:
{
  "analysis": "What went wrong and why",
  "suggestedGuideline": "The guideline text to add",
  "confidence": "high" | "medium" | "low",
  "relatedLegacyGuidelines": ["list of related legacy guideline snippets"]
}`;

  const result = await generateText({
    model: anthropic('claude-sonnet-4-20250514') as any,
    prompt,
    temperature: 0.7,
  });

  const parsed = analysisSchema.parse(JSON.parse(result.text));

  return {
    analysis: parsed.analysis,
    suggestedGuideline: parsed.suggestedGuideline,
    confidence: parsed.confidence,
    relatedLegacyGuidelines: parsed.relatedLegacyGuidelines,
  };
}
