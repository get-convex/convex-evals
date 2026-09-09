import { afterAll, expect } from "bun:test";
import { nativeProbeTest } from "./lib/nativeProbeTest";
import { ADMIN_KEY } from "../runner/convexBackend";
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

const NOW = 1_700_000_000_000;
const test = nativeProbeTest(
  "evals/002-queries/024-time_window_argument/answer",
  async (backend) => {
    // The clock probe runs real queries over real rows. Full grader tests own
    // assertions about the returned cutoff, count, and ordering.
    const response = await fetch(
      `http://localhost:${backend.port}/api/mutation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Convex ${ADMIN_KEY}`,
        },
        body: JSON.stringify({
          path: "_system/frontend/addDocument",
          args: {
            table: "items",
            documents: Array.from({ length: 105 }, (_, i) => ({
              name: `item-${i + 1}`,
              expiresAt: NOW + (i + 1) * 10,
            })),
          },
          format: "convex_encoded_json",
        }),
      },
    );
    const result = (await response.json()) as { status?: string };
    if (!response.ok || result.status !== "success")
      throw new Error(`Clock probe seed failed: ${JSON.stringify(result)}`);
  },
);

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
    const inspect = async () => {
      for (const now of [NOW, NOW + 1025, NOW + 1050]) {
        await inspectTimeWindowQuery(projectDir, fixture.timeArgName, now);
      }
    };
    if (fixture.probeValid) await inspect();
    else await expect(inspect()).rejects.toThrow();
  });
}
