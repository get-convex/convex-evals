import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { inspectBoundedQuery } from "../evals/002-queries/022-unbounded_query_no_collect/checks";
import { boundedQueryFixtures } from "./lib/boundedQueryFixtures";

const projectDir = mkdtempSync(join(tmpdir(), "bounded-query-"));
cpSync(
  resolve(
    "evals/002-queries/022-unbounded_query_no_collect/answer/convex/_generated",
  ),
  join(projectDir, "convex/_generated"),
  { recursive: true },
);
symlinkSync(
  resolve("node_modules"),
  join(projectDir, "node_modules"),
  "junction",
);
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

for (const fixture of boundedQueryFixtures) {
  test(`native bounded-read probe: ${fixture.name}`, () => {
    for (const [path, source] of Object.entries(fixture.files)) {
      const file = join(projectDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    const inspect = () => inspectBoundedQuery(projectDir);
    if (fixture.bounded) expect(inspect().bounds.length).toBeGreaterThan(0);
    else expect(inspect).toThrow();
  });
}
