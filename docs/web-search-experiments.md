# Web-search experiment handoff

This branch parks the web-search work from August 2026. It contains two related experiments:

- OpenRouter's native `openrouter:web_search` tool, tested with and without the Convex guidelines.
- Local runs through the Codex, Claude, and Grok coding-agent CLIs, with each CLI's web access enabled or disabled.

The aim was to measure the way people are likely to use these models. The prompt does not tell the model that it must search. Search choice, the provider's search index, and the coding harness are all part of the product being tested.

## API experiment

The manual GitHub Actions workflow is `.github/workflows/web_search_evals.yml`. It runs four conditions:

| Condition | `EVALS_EXPERIMENT` |
|---|---|
| Guidelines, no web | unset |
| Guidelines, web available | `web_search` |
| No guidelines, no web | `no_guidelines` |
| No guidelines, web available | `web_search_no_guidelines` |

The web-enabled conditions attach OpenRouter's server-side search tool. They do not add a prompt telling the model to use it. Run-level usage records how many evals searched and how many search requests OpenRouter reported.

The web runs below belong to the archived 109-eval benchmark. Baselines use the same benchmark partition so the API comparisons are like for like.

### With guidelines

| Model | Without web | With web |
|---|---:|---:|
| Claude Opus 5 | 91.6% | Not run |
| Claude Sonnet 5 | 85.8% | 89.9% |
| GPT-5.6 Sol | 97.2% | 98.2% |
| GPT-5.6 Luna | 83.6% | Not run |
| Grok 4.6 | 95.7% | 88.1% |
| Grok 4.5 | 90.4% | Not run |

### Without guidelines

| Model | Without web | With web |
|---|---:|---:|
| Claude Opus 5 | 79.2% | Not run |
| Claude Sonnet 5 | 76.0% | 84.4% |
| GPT-5.6 Sol | 82.9% | 90.8% |
| GPT-5.6 Luna | 57.8% | Not run |
| Grok 4.6 | 78.3% | 81.4% |
| Grok 4.5 | 76.4% | Not run |

Most API web cells have one run. Grok 4.6 has four. The baseline cells are averages over repeated production runs, so these percentages are useful evidence but not a final repeated trial.

## Native coding-agent experiment

Run a native matrix with:

```bash
EVALS_NATIVE_HARNESS=codex \
NATIVE_RESULTS_DIR=/path/to/results \
bun run native-harness:run
```

Replace `codex` with `claude` or `grok` for the other CLIs. The runner creates a clean workspace for every eval, alternates web-on and web-off order, disables network access in the no-web condition, and checkpoints every completed cell. It always uses the `no_guidelines` experiment.

The local checkpoints from this run are outside the repository at:

```text
/Users/m5-mike/dev/convex/convex-evals-native-results/2026-08-20/
```

### Native harness with web enabled

| Model | Passed | Score | Reported searches |
|---|---:|---:|---:|
| Claude Opus 5 | 99/111 | 89.2% | 0 |
| Claude Sonnet 5 | 84/111 | 75.7% | 0 |
| GPT-5.6 Sol | 80/90 | 88.9% | 12 |
| GPT-5.6 Luna | 63/91 | 69.2% | 8 |
| Grok 4.6 | 98/111 | 88.3% | 0 |
| Grok 4.5 | 97/111 | 87.4% | 0 |

Claude and Grok completed all 444 planned cells across both models and both web conditions. Codex completed 363 of 444 cells before its run stopped, so the Sol and Luna web percentages are partial.

Claude and Grok recorded no searches even though web access was enabled. Their scores measure the broader native CLI effect, not help from web research. Codex did search, but its matrix is incomplete.

## What the results say so far

The API result supports a modest claim for the three models tested with web access and no guidelines. All three improved. Sol rose from 82.9% to 90.8%, Sonnet from 76.0% to 84.4%, and Grok 4.6 from 78.3% to 81.4%.

The native result is less clean. A coding-agent CLI can improve a model through its file-editing loop and other built-in behavior even when it never searches. That makes native versus API a product comparison, not an isolated test of web access.

Before publishing a strong conclusion, run a representative set of 20 to 30 evals three times per condition. Keep the eval set, model version, guideline condition, and scoring code fixed. Report search adoption separately from pass rate so a harness that never searched does not get described as a web-search win.

## Branch status

This is parked research. It is not ready to merge as-is. The native implementation predates later runner changes on `main`, including removal of Cursor SDK support, so it will need rebasing and conflict resolution before another run.
