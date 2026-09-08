import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectTimeWindowQuery } from "../evals/002-queries/024-time_window_argument/checks";
import { timeWindowFixtures } from "./lib/timeWindowFixtures";

const root = mkdtempSync(join(tmpdir(), "time-window-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const fixture of timeWindowFixtures) {
  test(`time-window execution probe: ${fixture.name}`, async () => {
    const projectDir = join(root, fixture.name);
    cpSync(
      resolve(
        "evals/002-queries/024-time_window_argument/answer/convex/_generated",
      ),
      join(projectDir, "convex/_generated"),
      { recursive: true },
    );
    symlinkSync(
      resolve("node_modules"),
      join(projectDir, "node_modules"),
      "junction",
    );
    for (const [path, contents] of Object.entries(fixture.files)) {
      const destination = join(projectDir, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    const result = inspectTimeWindowQuery(
      projectDir,
      fixture.timeArgName,
      1_700_000_000_000,
    );
    if (fixture.valid) expect((await result).reads).toBeGreaterThan(0);
    else await expect(result).rejects.toThrow();
  });
}
