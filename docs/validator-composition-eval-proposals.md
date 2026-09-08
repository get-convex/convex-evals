# Validator composition replacement

Decision and validation record, 2026-09-08.

## Why this matters

This task measures whether a model can reuse a Convex object validator through
native composition. Duplicated validators can drift when a shared field changes:
update arguments can keep obsolete constraints, input validators can retain
server-managed fields, and public shapes can retain private fields.

The old article task mixed this capability with CRUD behavior, slug updates,
return validators, and schema-derived system fields. The replacement asks for
one base validator and four related transformations in one module. It stays one
eval, measuring one API family, rather than adding four separately weighted evals.

This is a validator-construction check. It does not prove that an application
uses the resulting validators correctly or enforces authorization. Schema-derived
stored-document validators remain covered by `016-schema_document_validator`.

We deliberately defer testing whether a model chooses these APIs unprompted.
Distinguishing reasonable alternative implementations from missed cleanup
opportunities is too difficult to grade reliably right now. This eval explicitly
requests native composition and measures correct use under that request. A pass
must not be presented as evidence of spontaneous API selection.

## Task and reference

The complete prompt is in
`evals/001-data_modeling/015-validator_composition/TASK.txt`.

| Export | Requested transformation | Reference |
| --- | --- | --- |
| `partialProfileValidator` | All three fields optional | `profileValidator.partial()` |
| `publicProfileValidator` | Only required `name` | `profileValidator.pick("name")` |
| `profileInputValidator` | Exclude `internalNote` | `profileValidator.omit("internalNote")` |
| `identifiedProfileValidator` | Add required string `externalId` | `profileValidator.extend({ externalId: v.string() })` |

The prompt requires native object-validator composition without naming those
four methods. It pins Convex to 1.44.0 and requires only `validators.ts` and
`package.json`. The old article reference backend and its generated files are
removed. No evalScores schema, deployment, or saved score changes are involved.

## Deterministic grading

The module pipeline installs dependencies, then the grader typechecks the module
and executes it using the actual pinned Convex SDK in a fresh child process.
The process has a stripped environment and execution timeouts. It is not a
hostile-code security sandbox.

The inspector wraps the SDK's native composition methods and records returned
object identities. The grader checks each exported validator's exact JSON shape
and optionality, its derivation from the exported base, and the provenance of
its retained field validators. Validator objects and field maps are frozen to
reject mutation. An unused correct call or a separately reconstructed identical
validator cannot satisfy derivation.

Aliases, helper functions, native chains, and semantically correct equivalents
pass. For example, omitting `email` and `internalNote` is valid for the public
shape. Native extension that wraps the original fields as optional is also valid.
This task measures composition capability, not recall of four distinct method
names. There is no AI grader or method-name-count heuristic.

The regression suite calls the same inspector and assertions as the real grader.
It covers valid alternatives, wrong shapes/types/optionality, mutation, manual
reconstruction, disconnected native calls, recreated fields inside native chains,
invalid TypeScript, and runaway module execution.

## Review and validation

- Canonical answer validation: 100% through the normal validation command.
- Grader regression matrix: 32 cases passed, including native equivalents and
  deliberately incorrect submissions.
- Disposable local Convex backend: 8 valid inputs accepted and 11 invalid inputs
  rejected using the reference validators as actual argument validators.
- `bun run typecheck` and `bun run test`: passed.
- Existing backend prompts compared byte for byte before/after, both with and
  without guidelines: unchanged.
- Astra on the final prompt: one default run and one `no_guidelines` run, both
  100%, followed by three fresh `no_guidelines` runs, also all 100%. Every answer
  used all four native methods correctly. The fresh runs had no custom
  guidelines or web-search tool; the prompt did not name the four methods.
  These are small samples, not an estimate of the model's pass rate or the
  guidelines' effect.

All local runs had production reporting disabled. Two earlier exploratory Astra
runs also passed, but preceded the module-specific prompt correction and are not
counted as final-prompt validation. No guideline text was changed.

The accompanying cascade-delete grader fix requires an error for a missing user
without prescribing its wording. Its canonical answer and all three archived
Astra answers passed the full local backend pipeline after that fix.

The replacement changes the meaning of this eval. Historical article-task scores
must not be reinterpreted as scores for this new task. A new benchmark version
should be minted after the intended eval batch is ready, with explicit approval.
