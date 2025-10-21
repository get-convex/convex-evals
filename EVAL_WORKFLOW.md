# Writing Convex Evals

This document outlines the workflow and best practices for creating effective Convex evaluation tests.

## Eval Structure

Each eval consists of:

1. A `TASK.txt` that describes the task
2. An `answer/` directory containing the reference solution
3. Within `answer/convex/`:
   - `schema.ts` - The database schema
   - Other necessary files (e.g., `public.ts`, `private.ts`)

## Implementation Workflow

1. **Create the Eval Structure**

   ```bash
   # If creating a new category
   mkdir -p evals/<category-number>-<category-name>

   # Create the eval
   python3 create_eval.py <eval_name> <category>
   ```

2. **Write the Prompt**

   - Create detailed requirements in `TASK.txt`
   - Include complete schema
   - Specify all function names and requirements

3. **Implement the Solution**

   1. Create `schema.ts` first
   2. Run codegen to generate types:
      ```bash
      cd evals/<category>/<eval>/answer && bunx convex codegen
      ```
   3. Implement solution files (e.g., `public.ts`)
   4. Run codegen again after any schema changes

4. **TypeScript Setup Notes**
   - Always run codegen after creating/modifying schema
   - Linter errors about indexes (e.g., "not assignable to parameter of type 'never'") indicate missing codegen
   - Some common type errors and their fixes:
     - Index fields: Requires codegen to resolve
     - Optional parameters: Use `v.optional(v.string())` in args
     - Return types: May need explicit type annotations

## Creating New Evals

1. Use `create_eval.py` to scaffold:

   ```bash
   python3 create_eval.py <eval_name> <category>
   ```

   This creates the basic directory structure and initializes a Convex project.

2. Categories should be organized by concept:
   - `000-fundamentals/` - Basic Convex concepts
   - `001-data_modeling/` - Schema design and relationships
   - `002-mutations/` - Data modification patterns
   - `003-queries/` - Query patterns and optimization
     etc.

## Writing Good Prompts

1. **Be Explicit About Schema**

   - Always provide the complete schema in the prompt
   - Use TypeScript code blocks for clarity
   - Include comments explaining field purposes

2. **Clear Requirements**

   - List specific functions to implement
   - For each function, specify:
     - Exact function name
     - Required arguments and their types
     - Expected return type/structure
     - Any specific behaviors or edge cases to handle

3. **Test Data Requirements**

   - Specify minimum number of test records
   - Define required data variations
   - Include specific scenarios to test

4. **Implementation Guidelines**
   - Highlight required patterns or approaches
   - Specify what NOT to do
   - Note performance considerations

## Example Prompt Structure

```markdown
Given this schema:

\`\`\`typescript
export default defineSchema({
// Schema definition with comments
});
\`\`\`

Write two functions:

1. A mutation named \`insertX\` that:

   - Specific requirements
   - Test data to insert
   - Edge cases to handle

2. A query named \`getY\` that:
   - Input parameters
   - Return structure
   - Required behavior
   - Performance considerations

Your solution should:

- Technical requirements
- Patterns to use/avoid
- Error handling expectations
```

## Common Eval Types

1. **Data Modeling**

   - Table relationships (1:1, 1:N, N:M)
   - Index design
   - Schema validation

2. **Query Patterns**

   - Basic CRUD operations
   - Index usage
   - Filtering and sorting
   - Joins and relationships
   - Aggregation and grouping

3. **Performance**
   - Efficient index usage
   - Parallel fetching
   - Batch operations
   - Query optimization

## Best Practices

1. **Focused Testing**

   - Each eval should test ONE main concept
   - Include related patterns only if they support the main concept
   - Keep requirements focused and clear

2. **Realistic Scenarios**

   - Use real-world examples when possible
   - Make data requirements meaningful
   - Include common edge cases

3. **Clear Success Criteria**

   - Make requirements explicit and testable
   - Include both functional and technical requirements
   - Specify performance expectations when relevant

4. **Progressive Complexity**
   - Order evals from simple to complex within categories
   - Build on previous concepts
   - Include stretch goals or optional optimizations

## Common Pitfalls to Avoid

1. **Ambiguous Requirements**

   - Don't leave function names unspecified
   - Don't use vague terms like "appropriate" without context
   - Always specify exact field names and types

2. **Over-complication**

   - Don't test multiple concepts in one eval
   - Don't require complex setup for simple concepts
   - Keep schemas focused on the tested concept

3. **Missing Context**

   - Don't assume knowledge of specific patterns
   - Include relevant documentation references
   - Explain performance implications

4. **Untestable Requirements**
   - Make success criteria measurable
   - Specify exact return types
   - Include specific test cases

## Solution File Organization

1. **Schema First**

   ```typescript
   // schema.ts
   import { defineSchema, defineTable } from "convex/server";
   import { v } from "convex/values";

   export default defineSchema({
     // Tables and indexes
   });
   ```

2. **Function Files**

   ```typescript
   // public.ts
   import { v } from "convex/values";
   import { mutation, query } from "./_generated/server";
   import { Id } from "./_generated/dataModel";  // If using IDs

   export const myFunction = query({...});
   ```

3. **Common Patterns**
   - Keep mutations and related queries in the same file
   - Group related functionality together
   - Include type imports from generated files
   - Add helpful comments for complex logic

## AI grading

The evals include a lightweight AI grader that reviews the generated project for each eval and provides concise reasoning on pass/fail.

- The grader builds a prompt from `TASK.txt` plus a manifest of files from the generated output directory and asks a model to decide pass/fail with reasoning.
- The helper logs reasoning on every run and, on failure, throws an error with that reasoning so it appears directly in the test output and in `run.log`.

### How to use in a grader test

Add a single standardized test using the helper:

```ts
import { createAIGraderTest } from "../../../grader/aiGrader";

// Basic usage (default name and 60s timeout)
createAIGraderTest(import.meta.url);

// Optional: custom name/timeout
createAIGraderTest(import.meta.url, "AI grader assessment", 60000);
```

That’s it. On failure, the thrown error message will include the AI reasoning. The same reasoning is logged to the console and captured in the eval’s `run.log` by the default Vitest reporter.
