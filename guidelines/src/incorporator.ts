import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { FailureAnalysis, IterationHistory, IterationFeedback } from './types.js';
import { getRecentIterationFeedback } from './iterationHistory.js';

const CONVEX_DOCS_DOMAINS = ['docs.convex.dev', 'stack.convex.dev'];

// Use Claude Opus for incorporation tasks (same as orchestrator)
const MODEL_ID = 'claude-opus-4-5';

// Maximum characters for legacy guidelines
const MAX_LEGACY_CHARS = 20000;

/**
 * Truncate content to a maximum length, keeping both start and end for context.
 */
function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  
  const halfSize = Math.floor(maxChars / 2) - 50;
  const start = content.slice(0, halfSize);
  const end = content.slice(-halfSize);
  const truncatedChars = content.length - maxChars;
  
  return `${start}\n\n... [${truncatedChars} characters truncated] ...\n\n${end}`;
}

/**
 * Group failure analyses by category based on eval name patterns
 */
function groupFailuresByCategory(
  analyses: Array<{ evalName: string; analysis: FailureAnalysis }>
): Map<string, Array<{ evalName: string; analysis: FailureAnalysis }>> {
  const categories = new Map<string, Array<{ evalName: string; analysis: FailureAnalysis }>>();

  for (const item of analyses) {
    const evalName = item.evalName;
    let category = 'Other';

    // Categorize based on eval path
    if (evalName.includes('pagination')) {
      category = 'Pagination';
    } else if (evalName.includes('import') || evalName.includes('helper_fns')) {
      category = 'Imports and Types';
    } else if (evalName.includes('storage') || evalName.includes('file')) {
      category = 'Storage';
    } else if (evalName.includes('query') || evalName.includes('index')) {
      category = 'Queries and Indexes';
    } else if (evalName.includes('mutation') || evalName.includes('patch') || evalName.includes('delete')) {
      category = 'Mutations';
    } else if (evalName.includes('action') || evalName.includes('http') || evalName.includes('node')) {
      category = 'Actions and HTTP';
    } else if (evalName.includes('cron') || evalName.includes('scheduler')) {
      category = 'Cron and Scheduling';
    } else if (evalName.includes('schema') || evalName.includes('data_modeling')) {
      category = 'Schema Design';
    } else if (evalName.includes('client') || evalName.includes('use_')) {
      category = 'React Client';
    } else if (evalName.includes('validator') || evalName.includes('returns')) {
      category = 'Validators';
    }

    if (!categories.has(category)) {
      categories.set(category, []);
    }
    categories.get(category)!.push(item);
  }

  return categories;
}

/**
 * Format iteration feedback for the prompt
 */
function formatIterationFeedback(feedback: IterationFeedback[]): string {
  if (feedback.length === 0) {
    return 'No previous iteration history available.';
  }

  return feedback
    .map((f) => {
      const direction = f.passCountDelta > 0 ? '+' : '';
      const status = f.passCountDelta > 0 ? 'improvement' : f.passCountDelta < 0 ? 'regression' : 'no change';
      
      let result = `### Iteration ${f.previousIteration} → ${f.currentIteration}: ${direction}${f.passCountDelta} passing (${status})\n`;
      result += `- Changes made: ${f.changesMade}\n`;
      
      if (f.evalsFlippedToPass.length > 0) {
        result += `- Evals that started passing: ${f.evalsFlippedToPass.slice(0, 5).join(', ')}`;
        if (f.evalsFlippedToPass.length > 5) {
          result += ` (and ${f.evalsFlippedToPass.length - 5} more)`;
        }
        result += '\n';
      }
      
      if (f.evalsFlippedToFail.length > 0) {
        result += `- Evals that regressed: ${f.evalsFlippedToFail.slice(0, 5).join(', ')}`;
        if (f.evalsFlippedToFail.length > 5) {
          result += ` (and ${f.evalsFlippedToFail.length - 5} more)`;
        }
        result += '\n';
      }
      
      return result;
    })
    .join('\n');
}

/**
 * Format grouped failure analyses for the prompt
 */
function formatGroupedFailures(
  grouped: Map<string, Array<{ evalName: string; analysis: FailureAnalysis }>>
): string {
  const sections: string[] = [];

  // Sort categories by number of failures (most first)
  const sortedCategories = Array.from(grouped.entries()).sort(
    (a, b) => b[1].length - a[1].length
  );

  for (const [category, items] of sortedCategories) {
    sections.push(`### ${category} Issues (${items.length} failure${items.length > 1 ? 's' : ''})`);
    
    for (const item of items.slice(0, 10)) { // Limit to 10 per category
      sections.push(
        `- **${item.evalName}** (confidence: ${item.analysis.confidence}): ${item.analysis.analysis.slice(0, 200)}${item.analysis.analysis.length > 200 ? '...' : ''}`
      );
      sections.push(`  - Suggested: ${item.analysis.suggestedGuideline.slice(0, 150)}${item.analysis.suggestedGuideline.length > 150 ? '...' : ''}`);
    }
    
    if (items.length > 10) {
      sections.push(`  - ... and ${items.length - 10} more similar failures`);
    }
    
    sections.push('');
  }

  return sections.join('\n');
}

async function getLegacyGuidelines(): Promise<string> {
  const path = join(import.meta.dir, '..', '..', 'runner', 'models', 'guidelines.py');
  if (!existsSync(path)) return '';

  return readFileSync(path, 'utf-8');
}

/**
 * Run the incorporator sub-agent to synthesize failure analyses into updated guidelines
 */
export async function runIncorporator(
  currentGuidelines: string,
  analyses: Array<{ evalName: string; analysis: FailureAnalysis }>,
  history: IterationHistory,
  logger?: { info: (msg: string, data?: any) => void }
): Promise<string> {
  // Group failures by category
  const groupedFailures = groupFailuresByCategory(analyses);
  
  // Get recent iteration feedback
  const recentFeedback = getRecentIterationFeedback(history, 5);
  
  // Get legacy guidelines
  const legacyGuidelines = await getLegacyGuidelines();
  const truncatedLegacy = truncateContent(legacyGuidelines, MAX_LEGACY_CHARS);

  // Web search tool for Convex docs lookup
  const webSearchTool = anthropic.tools.webSearch_20250305({
    maxUses: 5,
    allowedDomains: CONVEX_DOCS_DOMAINS,
  });

  const prompt = `You are an expert incorporator agent for Convex code generation guidelines.

Your task is to synthesize failure analyses into comprehensive, effective guidelines that address root causes rather than just symptoms.

## Current Guidelines
${currentGuidelines || 'None yet'}

## Iteration History & Feedback
${formatIterationFeedback(recentFeedback)}

## Failure Analyses (grouped by category)
${formatGroupedFailures(groupedFailures)}

## Legacy Guidelines (for reference)
${truncatedLegacy}

## Your Task

1. **Research First**: If you're unsure about Convex best practices or APIs, use web search to check the official Convex documentation (docs.convex.dev or stack.convex.dev).

2. **Identify Root Causes**: Look for patterns across multiple failures. For example:
   - If 5 failures are about pagination, what's the underlying misunderstanding?
   - Are there general Convex principles that would prevent these issues?

3. **Learn from History**: 
   - What changes in previous iterations helped? (evals that started passing)
   - What changes caused regressions? (evals that started failing)
   - Build on what worked, avoid what didn't

4. **Synthesize Guidelines**: Create updated guidelines that:
   - Address root causes, not just individual symptoms
   - Are organized by topic (imports, functions, database, etc.)
   - Include specific code examples where helpful
   - Are concise (50-100 tokens per guideline)
   - Deduplicate similar concepts
   - Resolve conflicts between suggestions
   - Prioritize high-confidence suggestions

5. **Think Critically**: 
   - Why are multiple similar issues occurring?
   - Is there a general Convex best practice that could help?
   - What would a Convex expert say about this pattern?

IMPORTANT FORMATTING RULES:
- Do NOT number the guidelines (no "1.", "2.", etc.)
- Use markdown headers (##) to organize by topic
- Use bullet points (-) for individual guidelines within each section
- Keep the format clean and scannable
- Each guideline should be 50-100 tokens

Return ONLY the updated guidelines text, no commentary.`;

  logger?.info('Running incorporator with web search capabilities');

  const result = await generateText({
    model: anthropic(MODEL_ID),
    prompt,
    tools: { web_search: webSearchTool },
    temperature: 0.7,
  });

  return result.text;
}
