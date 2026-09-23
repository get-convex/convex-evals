# Reviewed decision bank, September 23

The bank now contains 108 questions across 90 of the original 112 coding tasks.
The review retained 104 questions, replaced two and added two. It did not remove
questions because models answered them correctly. The 22 unrepresented sources
remain explicit in `decision-bank.json`, with updated explanations of their gaps.

## Why this matters

The four changes ask models to reason about observable Convex behavior from
short, concrete programs or configurations:

| Source | Change | Knowledge measured |
| --- | --- | --- |
| `000-fundamentals/007-basic_file_storage` | Replace `q-delete-both` | Deleting an application row and deleting its stored file are independent operations. Missing this leaves orphaned files or dangling references. |
| `007-components/000-aggregate_leaderboard` | Replace `q1` | Patching a source table alone leaves the component's aggregate index stale. |
| `007-components/011-choose_workpool_throttle` | Add `q-shared-cap` | Sharing a mounted pool shares one concurrency budget; separate mounts can exceed the intended combined cap. |
| `007-components/022-action_cache` | Add `q-permission-change` | An access check can permit the caller while the cache still returns a value generated under their old role. |

The existing Presence item already covers disconnecting one session while
another remains, then disconnecting the final session. It was kept without
adding a duplicate. Additional pilots were not promoted where source attribution
or a distinct, verified knowledge target was still missing.

The original coding tasks, reference answers, graders, schemas and guidelines
are unchanged. The question text and private answer keys match the approved
local candidate exactly. Author rationale and verification evidence are not
sent to models.

During promotion, four coverage notes for omitted sources were flattened from
nested lists to the same string-list shape as the other notes. This changes the
decision identity because it includes coverage metadata. It does not change
any model input, answer key, included source, question weight or local score.
The archive retains the original candidate hashes and records this normalization
separately.

## Local repeated runs

Before promotion, every model answered all 108 questions in three separate
local runs. Each run used one fixed option layout, shared across models and
rounds, no guidelines, and no model tools or web access. OpenRouter model IDs
were `typesafe/jev-1.13`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol` and
`openai/gpt-6-astra`. The chat models used low reasoning and a 4,096-token output
budget; native Jev requests omit those chat settings.

Scores average questions within each source task, then give each of the 90
represented tasks equal weight. SD below is the sample standard deviation of
three complete run scores, in percentage points.

| Model | Round 1 | Round 2 | Round 3 | Mean | SD | Reported cost, all 3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Astra | 98.89% | 98.89% | 97.78% | 98.52% | 0.64 | $1.59056 |
| Sol | 96.11% | 97.22% | 97.22% | 96.85% | 0.64 | $0.32854 |
| Luna | 92.96% | 90.74% | 93.33% | 92.35% | 1.40 | $0.03927 |
| Jev | 83.52% | 84.63% | 84.07% | 84.07% | 0.56 | $0.00885 |

All 1,296 responses were independently regraded. There were no retries, invalid
responses or provider errors. Across all models and rounds, 82 questions were
always correct and 26 had at least one miss. Astra missed Agent message
attribution in all three runs and the schema document validator once. These
results do not establish training-set provenance, unseen-task uncertainty or
independent coding ability.

These are local validation results, not published leaderboard runs. The hosted
workflow remains three matched option permutations per run with a 2,048-token
chat output budget. Its results should not be presented as the same experiment.
The request ceiling is now 648, enough for 108 questions times three permutations
with one transport retry each; the existing reported-spend guard still applies.

## Evidence and release

The [verification guide](decision-verification.md) describes the archived
execution evidence and portable replay limits. Unchanged questions retain
hash-bound historical evidence. The four changes bind to their exact executed
fixtures, including a fresh storage replay. A blind review covered all 108
questions; its four concerns were resolved using executable evidence before
model inference. Fresh schema document-validator and Agent-attribution replays
were part of that review. This was not a fresh runtime replay of all 108 items.

The decision identity is
`754a560edb3e2ea3147e284b9aae56a7a900129700aa6f8ad9e629b54af92c46`.
The coding identity remains
`41d65c9b4f5bcdb97bc5c6ead5aa054e335b2eab6abc897b352b97b98b016fb3`.

After review and merge, publishing this bank requires explicit approval to run
the existing **Mint Benchmark Version** workflow on `main` with `kind=decision`.
No schema migration or coding benchmark mint is required. Minting alone does not
make model calls. Production results must come from the existing **Decision
Model Evaluations** workflow on `main`; local validation runs must not be
uploaded as production runs. The website draft remains a separate release.
