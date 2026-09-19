# Writing Convex decision questions

This is the approved question-design standard applied to the September 2026 revision. It replaces the earlier local batch instructions. The release candidate contains 106 questions representing 90 of the 112 original coding evals. Its coverage ledger records the remaining gaps; decision scores do not establish equivalent coding ability.

The goal is to assess specific Convex knowledge through clear, fair multiple-choice questions. A good question exposes whether the model understands the relevant API or behavior, without making reading comprehension, arbitrary application rules or presentation clues do the work.

See [verification and replay](decision-verification.md) for the published evidence, exact scope of executable replay, and remaining portability work. The original approved document's SHA-256 is retained in the [verification manifest](../verification/decisions/manifest.json). Examples below explain authoring principles; they are not additional questions or inference instructions.

## 1. Start with the knowledge we want to measure

Read the original coding task, reference answer, grader and any known review findings. They can disagree. A reference implementation is evidence, not proof that every other implementation is wrong.

Before writing a question, record privately:

| Field | What to write |
|---|---|
| Source | The original eval and the exact requirement being converted. |
| Knowledge target | One sentence stating the Convex knowledge the model needs. |
| Why it matters | What breaks, behaves incorrectly or becomes inefficient without that knowledge. |
| Likely misconceptions | The plausible mistakes the alternatives will represent. |
| Held constant | Setup and application behavior supplied so they are not additional decisions. |
| Coverage limit | What the original coding task tested that this question does not. |

For example, the nested-limit question tests whether the model knows how to specify a native write cap on a child mutation. It does not test whether the model can independently implement the writer, parent error handling or job-status updates.

Use one main knowledge target per question. One coding eval may justify several questions when it contains distinct targets. It may also contain business rules or boilerplate that need no separate question. Do not turn every sentence of the coding task into an item.

Multiple choice measures recognition and application of supplied alternatives. Even a strong score does not establish the ability to produce a complete working implementation.

## 2. Use a simple situation and one direct question

The default structure is:

1. A short, concrete situation: what exists and what the developer wants to do.
2. Only the shared code and conditions needed to choose the answer.
3. One direct question.
4. Four plausible alternatives, with exactly one correct under those conditions.

Prefer ordinary developer language: “Which option…?”, “What happens…?” or “Which call…?” Avoid formal phrasing such as “the definition is bound to” or “which completion satisfies the aforementioned constraints.”

Remove repeated identifiers, requirements already fixed in every option, and explanations of behavior visible in unchanged code. Do not pad the prompt to sound rigorous. Equally, do not remove a condition that makes an alternative wrong.

**Our staged-index example**

The earlier question was:

> Which completion adds `by_workspaceId_and_status` on `["workspaceId", "status"]`, preserves the existing fields and index, and lets deployment complete without waiting for the new index to backfill?

The clearer version is:

> The `documents` table contains hundreds of millions of rows. You want to add an index on `workspaceId` and `status`.
>
> **Which option adds the index without making deployment wait for it to finish building?**

The actual prompt also retains the SDK version and shared schema code. The instruction to preserve existing fields and indexes is redundant here because all four choices already preserve them.

The other revised question stems follow the same pattern:

| Target | Question |
|---|---|
| Complete document validation | Which option uses the schema to validate the whole document? |
| Typed environment setup | Which setup gives this query a typed `SUPPORT_EMAIL` value and lets it compile and run? |
| Child write limit | Which call limits the child to five writes and rolls them all back if it tries a sixth? |

The setup still matters. Document validation names `_id` and `_creationTime`. Typed-env setup explicitly requires generated typing and compilation. Its misplaced-config alternative can read values at runtime when typechecking is bypassed, so asking only whether it “works” would be insufficient.

## 3. Preserve the missing knowledge when converting the task

Choose a question form that matches the target: select an API or short implementation, predict an outcome, diagnose a failure, or choose a component for a concrete requirement.

Do not supply the answer to the knowledge target in the common setup. Our earlier nested-limit question supplied `transactionLimits` in every option. It could test a different aspect of limits or rollback, but it could not detect the API-shape mistakes found in coding submissions.

If the target is where the write limit belongs, the alternatives should distinguish shapes such as:

```ts
{ maxNumWrites: 5 }
{ limits: { documentsWritten: 5 } }
{ transactionLimits: { documentsWritten: 5 } }
{ maxWrites: 5 }
```

If the target is what rolls back after a caught child failure, supplying the correct API call is appropriate. That is a separate question with a separate coverage claim.

Keep essential source-provided documentation when the coding task intentionally tests its application. Record whether an item tests knowledge without a supplied reference or understanding of supplied documentation. Do not quietly switch between those conditions.

## 4. Make each wrong option a plausible mistake

Prefer mistakes seen in actual coding submissions, after checking that they are model errors rather than ambiguous requirements, grader defects or infrastructure failures. Label alternatives based on observed mistakes separately from invented but plausible ones in the private evidence.

Each wrong option should represent one main misconception. Hold unrelated setup, arguments and application behavior constant. A choice should fail because of the intended distinction, not because an unrelated import or syntax error was added. An import path or API name can be the distinction when that is the knowledge being tested.

Use parallel code or wording with similar detail. Avoid absurd choices, alternatives that announce their own failure, or a correct option that is consistently longer and more carefully qualified. Do not add filler just to equalize character counts.

Ask: **Could someone choose the key from style or common sense without knowing the relevant Convex detail?** Inspect answer-position balance, option lengths and other obvious cues across the bank. Our first audit found the key was strictly longest in 129 of 149 questions. That was a bank-design problem even though it did not explain every correct model answer.

Exactly one option must satisfy the visible contract. A different valid implementation cannot be marked wrong merely because it differs from the reference answer. If three plausible wrong alternatives cannot be found, redesign or defer the item rather than inventing nonsense to fill four slots.

## 5. Verify the options and their actual failure reasons

For code-choice questions, verification is required before acceptance:

1. Define expected outcomes from the task contract independently of the keyed implementation.
2. Insert each exact displayed option into the same documented setup. Do not silently fix or translate it.
3. Typecheck options independently. Use isolated fixtures so one intentionally broken option cannot contaminate another's result.
4. Attempt the relevant SDK or backend execution. Use a disposable real local Convex backend when the claim depends on backend behavior.
5. Check the correct option on relevant ordinary, boundary and counterexample cases. Show a concrete failure for each wrong option and confirm the expected cause.
6. Make the smallest repair that removes each wrong option's misconception, and check it against the same expectations. Document any case where a repair control is not feasible.

Record static rejection, bundling or deployment failure, runtime exception, wrong output, transaction behavior and resource-limit behavior separately. If an option cannot initialize, do not claim that its later runtime cases executed. If typechecking is deliberately bypassed to observe runtime behavior, preserve both results.

Wrong options need not fail on every input. Our invented write-limit shapes succeed for small counts but fail the cap requirement at six writes. Likewise, runtime success does not satisfy a prompt that explicitly requires generated types and successful compilation.

An installation error, missing credential, network failure or broken harness does not prove an option wrong. If an allegedly wrong option satisfies the stated contract, investigate the question or key and preserve the observation.

For outcome-prediction questions, the alternatives describe possible results of one shared program:

1. Define the expected behavior from the visible contract independently of the selected answer.
2. Run the exact displayed program in the documented setup. Check the relevant return values, errors and persisted state.
3. Compare every prediction with the observations. Use targeted controls to distinguish competing explanations, such as whether an ordinary index rejects duplicate inserts or a later `unique()` lookup rejects multiple matches.
4. Record why the key fits and why each other prediction fails. Mark minimal code repairs as **not applicable: outcome prediction**. There are no separate wrong implementations to repair.

For other question forms, such as component selection, execute the relevant behavior or configurations where possible and record the evidence for every alternative. A prose-only review is not executable verification.

Match evidence to the claim. Record the exact code, execution context, exercised conditions, observations and remaining limits. State whether the fixture tests the displayed code in its intended context or uses a representative substitute. For example, running a field validator as a function argument with a matching table-field descriptor is evidence about validator behavior; it is not a direct table-write test. Explain why substitute evidence supports the question's knowledge target and what it leaves untested. Hold the item if a remaining gap prevents establishing a unique answer.

For concurrency, distinguish simultaneous client requests, observed conflict retries, and a directly traced or forced ordering of internal reads. Requests and retry logs alone do not prove that both initial reads returned empty. Also record other sources of conflict, such as shared account writes, before attributing a retry to index-range tracking.

Native SDK descriptors can establish how a staged index is declared; they do not measure backfill duration on hundreds of millions of rows. Tiny fast runs do not establish performance properties. Keep each claim within the evidence actually collected.

Record the SDK, component and backend identity actually tested. Keep necessary version assumptions visible in the prompt. No application schema changes are authorized by this verification workflow; those still require Michael's approval.

## 6. Keep reasoning and evidence out of model input

The evaluated model receives only the situation, necessary shared code, question and displayed alternatives, plus the selected shared instructions or guideline condition.

Keep the following in an author-only record available to human reviewers:

- The knowledge brief, source mapping and coverage limits.
- The correct key and the reason every option succeeds or fails.
- Whether each wrong option came from an observed mistake or was constructed.
- Fixtures, expected and actual results, errors, repair controls or their applicability, and evidence limits.
- Commands, runtime versions, hashes and review findings.

Check the exact serialized provider request. Keys, explanations, source IDs that hint at the answer, and neighboring questions that reveal it must not leak into the request. Run each question independently of earlier answers.

## 7. Review, freeze and measure separately

Correct code does not guarantee a good question. Before inference, review both the question and its evidence:

- Have a fresh reviewer answer using only what the evaluated model will see, before revealing the key or verification results.
- Then review source fidelity, alternative validity, exact-code evidence and coverage limits.
- Read the wording as a person. Remove unnecessary formality and redundant requirements without dropping deciding conditions.
- Resolve ambiguity and verification gaps before accepting the item.

Use separate clean-context Astra Extra High author and reviewer roles for bank audits. Give authors the source material and this standard. Keep keys and author reasoning out of the reviewer's initial blind packet. Human approval remains separate from model agreement.

Freeze prompts, options, keys and the run configuration before collecting results. Use matching shuffles and conditions across models. Save raw answers and independently check their mapping to the key. Keep malformed responses and provider failures distinguishable from knowledge errors; do not quietly exclude them to improve scores.

Shuffled repetitions measure stability, not additional independent concepts. If the aim is to measure the effect of wording itself, use enough contemporaneous, matched original/revised runs to separate it from ordinary variation. Our historical before/after comparison was exploratory.

Judge question quality by relevance, clarity, fairness and verified correctness. A lower score or an expected ordering by model size is not an acceptance criterion. Keep useful easy questions for coverage. Do not keep rewriting questions until a particular model fails.

Revisions receive a new recorded snapshot; old prompts, keys and results remain intact. Coding and decision questions continue to share one benchmark-version lineage. Keep results separated by evaluation format. Minting or publishing a shared version requires a separate approved step; local experiments do not publish anything automatically.

## 8. Audit and maintain the bank

Start with a current inventory. Reconcile each question with its original coding eval and knowledge target. Existing audit labels are leads to inspect, not final decisions.

Use these dispositions:

| Decision | When it applies |
|---|---|
| Keep | Relevant, clear, uniquely answerable and adequately verified, including useful easy coverage questions. |
| Reword | The concept and alternatives are sound, but the situation or question is unnecessarily difficult to read. |
| Rewrite | The concept matters, but the framing gives away the answer, alternatives are weak, or the key/visible contract is wrong. Reverify changed code. |
| Split | One question mixes distinct knowledge targets that can be tested more cleanly on their own. |
| Add | A meaningful source-eval concept is missing from the decision bank. State the gap and why existing questions do not cover it. |
| Retire | The item tests incidental app rules, duplicates another item without adding useful coverage, or cannot support a fair, relevant question after redesign. Record what replaces it or what coverage is lost. |
| Hold | The source contract, API behavior or verification remains unresolved. Do not count it as accepted coverage. |

Maintain a coverage ledger: source eval, intended concepts, question IDs, disposition, reason, evidence and review status, plus any gaps. Account for every source eval, including those with no suitable decision question. Do not claim full equivalent coverage when a conversion omits implementation skills or other targets.

More questions should not automatically give an original source eval more weight. Review coverage and scoring implications when splitting, deduplicating or retiring items. Retiring a decision question means removing it from a future candidate bank, not deleting the coding eval or historical evidence.

Apply this standard within the scope approved for the work: audit the bank, prepare revisions, verify them, and report changes and remaining coverage gaps. Subsequent model runs use a frozen candidate bank. Authoring approval does not authorize paid inference, publication, or benchmark minting.

## Acceptance checklist

- [ ] One clear Convex knowledge target and a practical reason to test it.
- [ ] Source task, reference and grader checked; disagreements resolved or explicitly held.
- [ ] Simple situation, direct question, and every deciding condition visible.
- [ ] Four plausible options with one verified key; no avoidable style or answer clues.
- [ ] Verification matches the question form: each code option and its repair checked, or the shared program and each outcome prediction checked with targeted controls.
- [ ] Exact execution context, observed failure causes and evidence limits recorded; substitutes and unobserved conditions identified; repair controls included or their applicability explained.
- [ ] Coverage limits and observed versus constructed mistakes documented privately.
- [ ] Blind review followed by evidence review; serialized model input contains no author-only material.
- [ ] Coverage ledger updated; accepted content frozen before inference.
- [ ] Historical artifacts preserved and shared versioning respected.

## File contract

Place `questions.json` beside the original coding eval's `TASK.txt`. Preserve the coding task, reference answer, grader, and schema. Keep author evidence under `verification/decisions/`, outside `answer/` and outside model input.

```json
{
  "version": 1,
  "sourceEval": "001-data_modeling/004-multi_column_index",
  "coverageNotes": "Tests index ordering, not implementation ability.",
  "questions": [
    {
      "id": "q1",
      "concept": "Equality prefix before range field",
      "context": "A messages table has author_email and sent_at fields.",
      "question": "Which index supports one author and a time interval using one index range?",
      "options": [
        { "id": "a", "text": "...", "rationale": "..." },
        { "id": "b", "text": "...", "rationale": "..." },
        { "id": "c", "text": "...", "rationale": "..." },
        { "id": "d", "text": "...", "rationale": "..." }
      ],
      "correctOptionId": "b",
      "sourceReferences": ["TASK.txt", "answer/convex/schema.ts", "grader.test.ts"]
    }
  ]
}
```

The runner sends only context, question, and shuffled option text, plus the selected shared instructions. Rationales, source references, concept labels, source IDs, and answer keys remain author/grader-only. An eval can retain an empty questions array when its decision items are retired; its coding evaluation remains intact.
