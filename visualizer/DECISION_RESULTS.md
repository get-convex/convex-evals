# Decision results

The visualizer now supports coding and decision results. Use the Coding / Decision
links in the top bar, or open `/decision` to browse decision runs by benchmark.

A result link identifies the immutable run plus the question and zero-based
repetition, for example:

```
/decision/run/<runId>?question=007-components%2F022-action_cache%2Fq1&repetition=0
```

The run view loads paginated outcomes for its task browser. It fetches the saved
source snapshot once and individual question evidence only when selected, using
a bounded browser cache. It does not invoke models or write to Convex.

Questions, answer explanations, and original coding tasks come from the run's
archived benchmark snapshot, not the latest repository files. Displayed choices
come from the recorded provider request, with annotations joined by exact option
text. Display letters are never interpreted as canonical answer IDs. Mismatched
artifacts and missing evidence produce explicit messages; provider errors and
invalid responses are distinct from incorrect answers.

## Local review

```
cd visualizer
bun install --frozen-lockfile
NETLIFY_DEV=true VITE_CONVEX_URL=https://fabulous-panther-525.convex.cloud bun run dev --host 127.0.0.1 --port 3102
```

This uses production data through public read-only queries. `NETLIFY_DEV=true`
skips the Netlify emulator for this standalone Vite preview (the installed Deno
may lack the emulator's required flags). Omit that variable for production builds.

The website can point its decision Evidence links at the local preview using
`NEXT_PUBLIC_EVALS_VISUALIZER_URL=http://127.0.0.1:3102` when starting Next. Its
default remains `https://convex-evals.netlify.app`.

Deploy the visualizer routes before publishing the website link changes. Neither
change needs a schema migration, benchmark version, or new model run.

## Checks

```
cd visualizer
bun run typecheck
bun run test
bun run build
```

Unit tests cover native decision and chat-shaped requests, shuffled answer
mapping, run/repetition identity, wrong-bank detection, invalid/provider-error
outcomes, and unrecorded repetitions. Browser review should include a correct and
incorrect answer, switching repetitions, filtering, source-task disclosure, the
run index, and a coding route to check existing navigation.
