import { afterAll, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectQuery } from "../grader/querySandbox";

const root = mkdtempSync(join(tmpdir(), "query-sandbox-process-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function probe(name: string, source: string): Promise<unknown> {
  const project = join(root, name);
  mkdirSync(join(project, "convex"), { recursive: true });
  symlinkSync(
    resolve("node_modules"),
    join(project, "node_modules"),
    "junction",
  );
  writeFileSync(join(project, "convex/example.ts"), source);
  const inspector = join(project, "inspect.mjs");
  writeFileSync(
    inspector,
    `export async function inspect(modules) { return (await modules.example()).value; }`,
  );
  return inspectQuery(project, pathToFileURL(inspector), {});
}

test("sandbox process returns structured values without stdout corruption", async () => {
  const value = {
    text: 'quoted "value"\nwith unicode: café',
    nested: [null, 42],
  };
  expect(
    await probe("structured", `export const value = ${JSON.stringify(value)};`),
  ).toEqual(value);
});

test("sandbox process reports guest exceptions", async () => {
  await rejects(
    probe(
      "error",
      `throw new Error("deliberate guest failure"); export const value = 1;`,
    ),
    /deliberate guest failure/,
  );
});

for (const [name, expression, expected] of [
  ["bigint", "9007199254740993n", 9007199254740993n],
  ["undefined", "undefined", undefined],
  ["nan", "NaN", NaN],
  ["positive-infinity", "Infinity", Infinity],
  ["negative-infinity", "-Infinity", -Infinity],
  ["negative-zero", "-0", -0],
] as const) {
  test(`sandbox process preserves ${name}`, async () => {
    expect(await probe(name, `export const value = ${expression};`)).toBe(
      expected,
    );
  });
}

test("sandbox process keeps host process unavailable", async () => {
  expect(
    await probe("isolation", "export const value = typeof globalThis.process;"),
  ).toBe("undefined");
});

test("sandbox process interrupts an infinite guest loop", async () => {
  await rejects(
    probe("loop", "while (true) {} export const value = 1;"),
    /interrupted|timed out/,
  );
}, 15_000);
