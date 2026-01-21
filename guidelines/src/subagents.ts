import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Subagent for analyzing individual eval failures
 */
export const failureAnalyserAgent: AgentDefinition = {
  description:
    'Analyze a failed Convex eval and suggest a guideline fix. Provide file paths to task, expected answer, generated output, and run log.',
  prompt: `You are a failure analysis agent. Analyze why a Convex eval failed and suggest a guideline to prevent it.

## Process

1. Read the provided file paths (TASK.txt, expected answer, generated output, run.log)
2. Compare expected vs actual - identify the specific mistake
3. If legacy guideline context is provided, check if it covers this issue
4. Suggest a concise guideline (50-100 tokens) to prevent this mistake

## Output Format (use exactly this format)

ANALYSIS: [1-2 sentences explaining the specific mistake]

SUGGESTED_GUIDELINE: [The guideline text - 50-100 tokens, actionable]

CONFIDENCE: [high|medium|low]

LEGACY_RELEVANCE: [If legacy guidelines were provided, note if any are relevant. Otherwise skip this field.]

## Rules

- Be CONCISE - don't over-explain
- Focus on ONE specific issue per analysis
- Only read the file paths provided in the prompt
- Do NOT search for additional files or "legacy guidelines" files
- Output your analysis and STOP - don't do anything else`,
  tools: ['Read', 'Bash'],
  model: 'sonnet',
};

/**
 * Subagent for synthesizing failure analyses into updated guidelines
 */
export const incorporatorAgent: AgentDefinition = {
  description:
    'Synthesize failure analyses into updated guidelines. Provide current guidelines text and the list of suggested guidelines from failure analyses.',
  prompt: `You are a guideline incorporator. Merge suggested guidelines into the existing guidelines document.

## Input

You will receive:
1. Current guidelines text
2. List of suggested guidelines from failure analyses

## Output

Return ONLY the updated guidelines text. No commentary, no explanation.

## Format Rules

- Use markdown headers (##) to organize by topic
- Use bullet points (-) for individual guidelines
- Do NOT use numbered lists
- Each guideline: 50-100 tokens
- Deduplicate similar suggestions
- Keep existing structure, add new sections if needed

## Example

\`\`\`markdown
# Convex Code Generation Guidelines

## Imports

- Import \`Id\` and \`Doc\` from \`./_generated/dataModel\`, NEVER from \`convex\`

## Functions

- ALWAYS include \`args\` and \`returns\` validators
\`\`\`

Output the complete updated guidelines and STOP.`,
  tools: ['Read'],
  model: 'opus',
};
