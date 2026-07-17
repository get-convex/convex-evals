import { expect, test, beforeEach } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  addDocuments,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";
import { PaginationOptions, PaginationResult } from "convex/server";

type Entry = Doc<"auditEntries">;

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["auditEntries"]);
});

async function listFailed(
  workspaceId: string,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Entry>> {
  return await responseClient.query(api.index.listFailedAuditEntries, {
    workspaceId,
    paginationOpts,
  });
}

/** count entries, one failed entry every `failedEvery` sequences. */
function seedEntries(
  workspaceId: string,
  count: number,
  failedEvery: number,
  payload: (sequence: number) => string = (sequence) => `entry ${sequence}`,
) {
  return Array.from({ length: count }, (_, i) => {
    const sequence = i + 1;
    return {
      workspaceId,
      sequence,
      status: sequence % failedEvery === 0 ? "failed" : "ok",
      payload: payload(sequence),
    };
  });
}

function failedSequences(count: number, failedEvery: number): number[] {
  const result: number[] = [];
  for (let sequence = failedEvery; sequence <= count; sequence += failedEvery) {
    result.push(sequence);
  }
  return result;
}

/** Every page item must be a failed entry of the workspace, ascending. */
function expectFailedAscending(page: Entry[], workspaceId: string) {
  for (const entry of page) {
    expect(entry.workspaceId).toBe(workspaceId);
    expect(entry.status).toBe("failed");
  }
  const sequences = page.map((entry) => entry.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
}

// ws_basic: 30 entries, failed at 3,6,...,30. ws_decoy: failed at every
// sequence, so any cross-workspace leak changes page contents.
async function seedBasicAndDecoy() {
  await addDocuments(responseAdminClient, "auditEntries", [
    ...seedEntries("ws_basic", 30, 3),
    ...seedEntries("ws_decoy", 30, 1),
  ]);
}

// ws_sparse: 120 entries with long ok-stretches, failed at 20,40,...,120.
async function seedSparse() {
  await addDocuments(
    responseAdminClient,
    "auditEntries",
    seedEntries("ws_sparse", 120, 20),
  );
}

test(
  "first page has exactly numItems failed entries in ascending sequence order",
  { timeout: 15_000 },
  async () => {
    await seedBasicAndDecoy();

    const result = await listFailed("ws_basic", { numItems: 4, cursor: null });
    expectFailedAscending(result.page, "ws_basic");
    expect(result.page.map((entry) => entry.sequence)).toEqual([3, 6, 9, 12]);
    expect(result.isDone).toBe(false);

    // All ten matches fit in one page.
    const all = await listFailed("ws_basic", { numItems: 12, cursor: null });
    expect(all.page.map((entry) => entry.sequence)).toEqual(
      failedSequences(30, 3),
    );
    expect(all.isDone).toBe(true);

    // A workspace with no entries at all.
    const empty = await listFailed("ws_missing", { numItems: 5, cursor: null });
    expect(empty.page).toEqual([]);
    expect(empty.isDone).toBe(true);
  },
);

test(
  "cursor walk visits every failed entry exactly once, in order",
  { timeout: 20_000 },
  async () => {
    await seedBasicAndDecoy();

    const seen: number[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    let isDone = false;
    for (let i = 0; i < 12 && !isDone; i++) {
      const result: PaginationResult<Entry> = await listFailed("ws_basic", {
        numItems: 3,
        cursor,
      });
      expectFailedAscending(result.page, "ws_basic");
      seen.push(...result.page.map((entry) => entry.sequence));
      pageSizes.push(result.page.length);
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    expect(isDone).toBe(true);
    // No duplicates, no gaps, nothing from ws_decoy.
    expect(seen).toEqual(failedSequences(30, 3));
    // Pages are filled to numItems while matches remain: a query that
    // paginates first and filters the page afterwards returns short pages.
    expect(pageSizes).toEqual([3, 3, 3, 1]);
  },
);

test(
  "maximumRowsRead bounds the scan and reports the split",
  { timeout: 15_000 },
  async () => {
    await seedSparse();

    // Finding 3 matches requires reading 60 rows; the budget allows 50.
    const result = await listFailed("ws_sparse", {
      numItems: 3,
      cursor: null,
      maximumRowsRead: 50,
    });
    expectFailedAscending(result.page, "ws_sparse");
    // The page stops early instead of reading past the budget...
    expect(result.page.length).toBeLessThan(3);
    expect(result.page.length).toBeGreaterThan(0);
    // ...containing a prefix of the matches, not a resampling of them.
    expect(result.page.map((entry) => entry.sequence)).toEqual(
      failedSequences(120, 20).slice(0, result.page.length),
    );
    expect(result.isDone).toBe(false);
    expect(result.pageStatus).toBe("SplitRequired");
    expect(result.splitCursor).toBeTruthy();
  },
);

test(
  "budgeted cursor walk completes with no gaps or duplicates",
  { timeout: 30_000 },
  async () => {
    await seedSparse();

    const seen: number[] = [];
    let cursor: string | null = null;
    let isDone = false;
    // 120 rows at >= 50 rows scanned per request needs ~3 requests; the guard
    // fails the test if the cursor stops advancing.
    for (let i = 0; i < 15 && !isDone; i++) {
      const result: PaginationResult<Entry> = await listFailed("ws_sparse", {
        numItems: 3,
        cursor,
        maximumRowsRead: 50,
      });
      expectFailedAscending(result.page, "ws_sparse");
      seen.push(...result.page.map((entry) => entry.sequence));
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    expect(isDone).toBe(true);
    expect(seen).toEqual(failedSequences(120, 20));
  },
);

test(
  "endCursor bounds the page to a fixed range regardless of numItems",
  { timeout: 15_000 },
  async () => {
    await seedSparse();

    const firstTwo = await listFailed("ws_sparse", {
      numItems: 2,
      cursor: null,
    });
    expect(firstTwo.page.map((entry) => entry.sequence)).toEqual([20, 40]);
    const firstFour = await listFailed("ws_sparse", {
      numItems: 4,
      cursor: null,
    });
    expect(firstFour.page.map((entry) => entry.sequence)).toEqual([
      20, 40, 60, 80,
    ]);

    // numItems 1 must NOT shrink the range: everything up to endCursor comes
    // back and the page ends exactly at endCursor.
    const firstHalf = await listFailed("ws_sparse", {
      numItems: 1,
      cursor: null,
      endCursor: firstTwo.continueCursor,
    });
    expect(firstHalf.page.map((entry) => entry.sequence)).toEqual([20, 40]);
    expect(firstHalf.continueCursor).toBe(firstTwo.continueCursor);
    expect(firstHalf.isDone).toBe(false);

    const secondHalf = await listFailed("ws_sparse", {
      numItems: 1,
      cursor: firstTwo.continueCursor,
      endCursor: firstFour.continueCursor,
    });
    expect(secondHalf.page.map((entry) => entry.sequence)).toEqual([60, 80]);
    expect(secondHalf.continueCursor).toBe(firstFour.continueCursor);

    // The two bounded ranges union to exactly the unsplit range.
    expect([
      ...firstHalf.page.map((entry) => entry.sequence),
      ...secondHalf.page.map((entry) => entry.sequence),
    ]).toEqual(firstFour.page.map((entry) => entry.sequence));
  },
);

test(
  "splitCursor halves union to the original budget-limited page",
  { timeout: 15_000 },
  async () => {
    await seedSparse();

    const budgeted = await listFailed("ws_sparse", {
      numItems: 3,
      cursor: null,
      maximumRowsRead: 50,
    });
    expect(budgeted.pageStatus).toBe("SplitRequired");
    expect(budgeted.splitCursor).toBeTruthy();

    // Per the split contract: (cursor, splitCursor] then
    // (splitCursor, continueCursor] replace the original page.
    const firstHalf = await listFailed("ws_sparse", {
      numItems: 3,
      cursor: null,
      endCursor: budgeted.splitCursor!,
    });
    const secondHalf = await listFailed("ws_sparse", {
      numItems: 3,
      cursor: budgeted.splitCursor!,
      endCursor: budgeted.continueCursor,
    });
    expect(secondHalf.continueCursor).toBe(budgeted.continueCursor);
    expect([
      ...firstHalf.page.map((entry) => entry.sequence),
      ...secondHalf.page.map((entry) => entry.sequence),
    ]).toEqual(budgeted.page.map((entry) => entry.sequence));
  },
);

test(
  "maximumBytesRead bounds reads under large payloads",
  { timeout: 30_000 },
  async () => {
    // 30 entries with ~8KB payloads, failed at 2,4,...,30.
    await addDocuments(
      responseAdminClient,
      "auditEntries",
      seedEntries("ws_bytes", 30, 2, () => "x".repeat(8192)),
    );
    const expected = failedSequences(30, 2);

    // 15 matches exist, but a 40KB budget only covers a handful of 8KB rows.
    const result = await listFailed("ws_bytes", {
      numItems: 10,
      cursor: null,
      maximumBytesRead: 40_000,
    });
    expectFailedAscending(result.page, "ws_bytes");
    expect(result.page.length).toBeGreaterThan(0);
    expect(result.page.length).toBeLessThanOrEqual(5);
    expect(result.page.map((entry) => entry.sequence)).toEqual(
      expected.slice(0, result.page.length),
    );
    expect(result.isDone).toBe(false);
    expect(result.pageStatus).toBe("SplitRequired");

    // The budgeted walk still reaches every match exactly once.
    const seen = result.page.map((entry) => entry.sequence);
    let cursor = result.continueCursor;
    let isDone = false;
    for (let i = 0; i < 25 && !isDone; i++) {
      const next: PaginationResult<Entry> = await listFailed("ws_bytes", {
        numItems: 10,
        cursor,
        maximumBytesRead: 40_000,
      });
      expectFailedAscending(next.page, "ws_bytes");
      seen.push(...next.page.map((entry) => entry.sequence));
      cursor = next.continueCursor;
      isDone = next.isDone;
    }
    expect(isDone).toBe(true);
    expect(seen).toEqual(expected);
  },
);

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});
