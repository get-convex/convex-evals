import { $ } from "bun";
import { access, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyEnvFromSiblingWorktree() {
  const target = resolve(".env");
  if (await fileExists(target)) {
    return;
  }

  const worktreesOutput = await $`git worktree list --porcelain`.text();
  const worktrees = worktreesOutput
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());

  for (const worktree of worktrees) {
    const source = join(worktree, ".env");
    if (resolve(source) === target || !(await fileExists(source))) {
      continue;
    }

    await copyFile(source, target);
    console.log(`[codex] copied ignored .env from ${worktree}`);
    return;
  }

  console.log("[codex] no sibling .env found; API keys may need manual setup");
}

await $`bun install`;
await copyEnvFromSiblingWorktree();
await $`bun run setup:convex`;
