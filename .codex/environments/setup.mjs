import { $ } from "bun";

// scripts/setup.ts installs the root, evalScores and visualizer dependencies,
// copies .env from a sibling worktree and runs setup:convex.
await $`bun run setup`;
