import { afterAll, expect } from "bun:test";
import { version } from "convex";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
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
import { ADMIN_KEY } from "../runner/convexBackend";
import { nativeProbeTest } from "./lib/nativeProbeTest";

let backendUrl: string;
const test = nativeProbeTest(
  "evals/005-idioms/008-nested_transaction_limits/answer",
  async (backend) => {
    backendUrl = `http://localhost:${backend.port}`;
  },
);
const root = mkdtempSync(join(tmpdir(), "query-probe-isolation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function probe<T>(name: string, source: string): Promise<T> {
  const project = join(root, name);
  mkdirSync(join(project, "convex"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(project, "node_modules"), "dir");
  writeFileSync(join(project, "convex/example.ts"), source);
  const inspector = join(project, "inspect.mjs");
  writeFileSync(
    inspector,
    "export async function inspect(modules) { return (await modules.example()).value; }",
  );
  return inspectQuery<T>(project, pathToFileURL(inspector), {});
}

async function storedState(): Promise<unknown[][]> {
  // These fresh requests inspect committed state outside the one-off query.
  const client = new ConvexHttpClient(backendUrl);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
    ADMIN_KEY,
  );
  const listTable = makeFunctionReference<
    "query",
    { table: string; limit: number },
    unknown[]
  >("_system/frontend/listTableScan");
  const scheduledJobs = makeFunctionReference<
    "query",
    { paginationOpts: { cursor: null; numItems: number } },
    { page: unknown[] }
  >("_system/frontend/paginatedScheduledJobs");
  return Promise.all([
    ...["jobs", "deliveries"].map((table) =>
      client.query(listTable, { table, limit: 10 }),
    ),
    client
      .query(scheduledJobs, {
        paginationOpts: { cursor: null, numItems: 10 },
      })
      .then((result) => result.page),
  ]);
}

// Low-level writes are deliberately used to test the actual boundary. The
// endpoint permits staged writes and schedules but must never commit them.
const stagedEffects = `
  const inserted = JSON.parse(await globalThis.Convex.asyncSyscall(
    "1.0/insert",
    JSON.stringify({ table: "jobs", value: { name: "probe-only", status: "pending" } }),
  ));
  const visible = JSON.parse(await globalThis.Convex.asyncSyscall(
    "1.0/get",
    JSON.stringify({ table: "jobs", id: inserted._id, isSystem: false }),
  ));
  const scheduled = JSON.parse(await globalThis.Convex.asyncSyscall(
    "1.0/schedule",
    JSON.stringify({
      name: "index:processFanout",
      args: { jobId: inserted._id, count: 1 },
      ts: Date.now() / 1000,
      version: ${JSON.stringify(version)},
    }),
  ));
`;

test("probe inserts and scheduled mutations never reach committed state", async () => {
  expect(await storedState()).toEqual([[], [], []]);
  const result = await probe<{
    visible: { name: string; status: string };
    scheduled: string;
  }>(
    "staged-effects",
    `export const value = (async () => { ${stagedEffects} return { visible, scheduled }; })();`,
  );
  expect(result.visible).toMatchObject({
    name: "probe-only",
    status: "pending",
  });
  expect(typeof result.scheduled).toBe("string");
  expect(await storedState()).toEqual([[], [], []]);
});

test("candidate exceptions also discard staged inserts and schedules", async () => {
  expect(await storedState()).toEqual([[], [], []]);
  await rejects(
    probe(
      "staged-effects-then-error",
      `export const value = (async () => { ${stagedEffects} throw new Error("candidate failed after scheduling"); })();`,
    ),
    /candidate failed after scheduling/,
  );
  expect(await storedState()).toEqual([[], [], []]);
});

test("separate probes do not share mutable globals or native prototypes", async () => {
  await probe(
    "write-globals",
    `globalThis.probeCounter = 99;
    Object.prototype.probeMarker = "poisoned";
    Date.now = () => 7;
    export const value = true;`,
  );
  expect(
    await probe<{
      counter: number | null;
      marker: string | null;
      clockPoisoned: boolean;
    }>(
      "read-globals",
      `export const value = {
      counter: globalThis.probeCounter ?? null,
      marker: ({}).probeMarker ?? null,
      clockPoisoned: Date.now() === 7,
    };`,
    ),
  ).toEqual({ counter: null, marker: null, clockPoisoned: false });
});

test("native probes cannot access Node filesystem or the network", async () => {
  const result = await probe<{
    nodeFilesystem: boolean;
    hostProcess: string;
    networkError: string | null;
  }>(
    "host-and-network",
    `export const value = (async () => {
      let nodeFilesystem = false;
      try { nodeFilesystem = typeof require("node:fs").readFileSync === "function"; } catch {}
      let networkError = null;
      try { await fetch(${JSON.stringify(backendUrl + "/version")}); }
      catch (error) { networkError = String(error); }
      return { nodeFilesystem, hostProcess: typeof process.versions, networkError };
    })();`,
  );
  expect(result.nodeFilesystem).toBe(false);
  expect(result.hostProcess).toBe("undefined");
  expect(result.networkError).toContain("Can't use fetch() in queries");
});
