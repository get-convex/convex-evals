import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { walkAnswer, type ScoreResult } from "../runner/scorer";

const root = mkdtempSync(join(tmpdir(), "validator-scoring-"));
const repository = resolve(import.meta.dir, "..");
const answer = join(
  repository,
  "evals/001-data_modeling/015-validator_composition/answer",
);
const reference = Object.fromEntries(
  [...walkAnswer(answer)].map((path) => [
    relative(answer, path),
    readFileSync(path, "utf8"),
  ]),
);

// Use the real scorer and Vitest reporter in a child process so reporting state
// and other tests' mocks cannot change the outcome. No model generation occurs.
const replay = join(root, "replay.ts");
writeFileSync(
  replay,
  `import { convexScorer } from ${JSON.stringify(join(repository, "runner/scorer.ts"))};
import { inspectValidators } from ${JSON.stringify(join(repository, "evals/001-data_modeling/015-validator_composition/checks.ts"))};
import { GraderInfrastructureError } from ${JSON.stringify(join(repository, "grader/infrastructure.ts"))};
const [name, suffix] = process.argv.slice(2);
if (name === "missing-node") {
  process.env.PATH = ${JSON.stringify(root)};
  try { inspectValidators(${JSON.stringify(root)}); }
  catch (error) { if (error instanceof GraderInfrastructureError) process.exit(0); throw error; }
  throw new Error("Expected unavailable Node to be infrastructure");
}
const output = ${JSON.stringify(reference)};
output["validators.ts"] += suffix;
const scores = await convexScorer(${JSON.stringify(root)} + "/" + name, "", {}, {
  model: "fixture", category: "001-data_modeling", eval_name: "015-validator_composition",
}, output);
await Bun.write(${JSON.stringify(root)} + "/" + name + ".json", JSON.stringify(scores));
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("validator inspection treats an unavailable Node executable as infrastructure", async () => {
  const child = Bun.spawn([process.execPath, replay, "missing-node"], {
    cwd: repository,
    env: { ...process.env, DISABLE_CONVEX_REPORTING: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stdout + stderr).toBe(0);
});

for (const [name, suffix, expectedScore] of [
  ["reference", "", 1],
  ["candidate-exception", '\nthrow new Error("candidate module failed");', 0],
  ["candidate-timeout", "\nwhile (true) {}", 0],
] as const) {
  test(`validator scoring attributes ${name} to the answer`, async () => {
    const child = Bun.spawn([process.execPath, replay, name, suffix], {
      cwd: repository,
      env: { ...process.env, DISABLE_CONVEX_REPORTING: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // InfrastructureError would reject convexScorer and make this process
    // fail. Candidate exceptions must instead produce an ordinary test score.
    expect(exit, stdout + stderr).toBe(0);
    const scores = JSON.parse(
      readFileSync(join(root, `${name}.json`), "utf8"),
    ) as ScoreResult[];
    expect(scores.find((score) => score.name === "Tests pass")?.score).toBe(
      expectedScore,
    );
  }, 60_000);
}
