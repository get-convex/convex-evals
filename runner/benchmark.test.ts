import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { computeBenchmarkDefinition } from "./benchmark.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "convex-evals-benchmark-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "runner", "models"), { recursive: true });
  writeFileSync(join(root, "runner", "models", "guidelines.md"), "Be good.\n");
  for (const evalPath of ["evals/000/a", "evals/001/b"]) {
    mkdirSync(join(root, evalPath), { recursive: true });
    writeFileSync(join(root, evalPath, "TASK.txt"), `${evalPath}\n`);
  }
  return root;
}

describe("computeBenchmarkDefinition", () => {
  it("is stable regardless of eval discovery order", () => {
    const root = createProject();
    const first = computeBenchmarkDefinition(
      ["evals/000/a", "evals/001/b"],
      root,
    );
    const second = computeBenchmarkDefinition(
      ["evals/001/b", "evals/000/a"],
      root,
    );

    expect(first).toEqual(second);
    expect(first.evalCount).toBe(2);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when an eval changes", () => {
    const root = createProject();
    const before = computeBenchmarkDefinition(["evals/000/a"], root);
    writeFileSync(join(root, "evals/000/a/TASK.txt"), "Changed task\n");
    const after = computeBenchmarkDefinition(["evals/000/a"], root);

    expect(after.version).not.toBe(before.version);
  });

  it("changes when guidelines change", () => {
    const root = createProject();
    const before = computeBenchmarkDefinition(["evals/000/a"], root);
    writeFileSync(join(root, "runner/models/guidelines.md"), "New rules.\n");
    const after = computeBenchmarkDefinition(["evals/000/a"], root);

    expect(after.version).not.toBe(before.version);
  });
});
