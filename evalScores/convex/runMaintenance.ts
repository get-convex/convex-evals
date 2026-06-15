/**
 * Maintenance tasks for the runs table.
 * Called by cron jobs to clean up stuck or stale runs.
 */
import { internalMutation } from "./_generated/server";

/** Maximum age (in ms) before a pending/running run is considered stuck (3 hours) */
const STUCK_RUN_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/** How far back to scan for stuck runs (7 days). Bounds the query to avoid full table scans. */
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Find runs that have been in "pending" or "running" state for longer than
 * the threshold and mark them as failed. This handles cases where the
 * runner process crashed or was killed without completing the run.
 *
 * Only scans a bounded time window (last 7 days) to avoid reading the
 * entire runs table. Runs older than the window that are still stuck
 * will be caught on successive passes.
 */
export const failStuckRuns = internalMutation({
  args: {},
  returns: undefined,
  handler: async (ctx) => {
    const now = Date.now();
    const stuckCutoff = now - STUCK_RUN_THRESHOLD_MS;
    const scanFloor = now - SCAN_WINDOW_MS;

    // Only scan runs created in the last 7 days that are older than 3 hours.
    // Uses _creationTime filter to bound the read set.
    const candidates = await ctx.db
      .query("runs")
      .order("desc")
      .filter((q) =>
        q.and(
          q.lt(q.field("_creationTime"), stuckCutoff),
          q.gt(q.field("_creationTime"), scanFloor),
        ),
      )
      .collect();

    let failedCount = 0;
    for (const run of candidates) {
      if (run.status.kind !== "pending" && run.status.kind !== "running") continue;

      const elapsedMs = now - run._creationTime;
      await ctx.db.patch("runs", run._id, {
        status: {
          kind: "failed",
          failureReason: `Run stuck in "${run.status.kind}" state for ${Math.round(elapsedMs / 1000 / 60)} minutes — auto-failed by maintenance cron`,
          durationMs: elapsedMs,
        },
      });
      failedCount++;
    }

    if (failedCount > 0) {
      console.log(`failStuckRuns: marked ${failedCount} stuck run(s) as failed`);
    }
  },
});
