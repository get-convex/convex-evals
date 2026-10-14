# Decision model cohort

The decision benchmark uses nine native decision models and four LLM references.
This keeps the comparison focused on models that return typed choices with
probabilities, while retaining a few familiar quality and cost references.

Jev is a required baseline. Every decision benchmark refresh should populate
its three complete hosted runs first, with the usual approval for paid calls.
The CI cohort test prevents removing it from the configured cohort. It does not
automatically run models or guarantee a score exists on a newly minted version.

| Workflow key         | Pinned OpenRouter model            | API       |
| -------------------- | ---------------------------------- | --------- |
| `jev`                | `typesafe/jev-1.13`                | Decisions |
| `drex2`              | `nace-ai/drex-v2.0`                | Decisions |
| `clefomni`           | `cloudflare/clef-omni`             | Decisions |
| `mercurydecide`      | `inception/mercury-decide`         | Decisions |
| `liquidd1`           | `liquid/d1`                        | Decisions |
| `microsoftdecision1` | `microsoft/microsoft-decision-1`   | Decisions |
| `decider11`          | `perplexity/pplx-decider-v1.1-27b` | Decisions |
| `solardecideflash`   | `upstage/solar-decide-flash`       | Decisions |
| `classify1`          | `scaledown/classify-1`             | Decisions |
| `luna6`              | `openai/gpt-6-luna`                | Chat      |
| `sol61`              | `openai/gpt-6.1-sol`               | Chat      |
| `opus55`             | `anthropic/claude-opus-5.5`        | Chat      |
| `gemini4argon`       | `google/gemini-4-argon`            | Chat      |

The native IDs were checked against OpenRouter's
[decision catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions)
on 14 October 2026. Catalog presence confirms the advertised API and pricing,
not a successful inference call. All nine models also returned valid choice
distributions in local two-question smoke tests on that date. These are
integration checks, not model-quality comparisons. Classify-1 requires the shared
context to be serialized as a JSON string because ScaleDown does not accept the
arbitrary state object used by the other models. Retest new model additions
locally, with spend approval, before hosted baseline runs. Use paid, pinned IDs rather than free
variants or moving latest aliases for comparable runs.

Clef Omni represents Cloudflare. The Clef and Clef Flash listings warn that
Workers AI truncates text state to about 2K tokens; they are not included in this
cohort. Check the selected provider's limits during smoke testing.

`NATIVE_DECISION_MODELS` in `runner/decisions/protocol.ts` supplies the native
cohort and the shared native API allowlist. `DECISION_CI_MODELS` adds the four chat
references. The workflow options and `all` matrix must match that combined list.
The current decision table uses this list rather than coding's `ALL_MODELS`.
Decision benchmarks retain a link to their coding source without sharing its
model cohort. Legacy shared-version archives keep their original comparisons.

Changing this cohort does not change question text, scoring, or the semantic
benchmark identity. It does not delete historical results, mint a benchmark, or launch inference. The current leaderboard shows only this
cohort; older benchmark views retain their original rows. The decision
workflow is manual, and its default `none` makes no calls. After smoke testing
and merge approval, fill missing current-benchmark runs through that workflow
on `main`; each job uses three matched option permutations. Keep completed
existing reference runs rather than repeating them just because the cohort
changed.
