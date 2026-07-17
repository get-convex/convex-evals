import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";

const BYTES_READ_RESERVE = 15 * 1024 * 1024;
const BYTES_WRITTEN_RESERVE = 15 * 1024 * 1024;
const DOCUMENTS_READ_RESERVE = 31_990;
const DOCUMENTS_WRITTEN_RESERVE = 15_990;

async function deleteArchivedBatch(ctx: MutationCtx, workspaceId: string) {
  const query = ctx.db
    .query("records")
    .withIndex("by_workspaceId_archived", (q) =>
      q.eq("workspaceId", workspaceId).eq("archived", true),
    );
  for await (const record of query) {
    await ctx.db.delete("records", record._id);
    const metrics = await ctx.meta.getTransactionMetrics();
    if (
      metrics.bytesRead.remaining <= BYTES_READ_RESERVE ||
      metrics.bytesWritten.remaining <= BYTES_WRITTEN_RESERVE ||
      metrics.documentsRead.remaining <= DOCUMENTS_READ_RESERVE ||
      metrics.documentsWritten.remaining <= DOCUMENTS_WRITTEN_RESERVE
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.index.continueDeleteArchivedRecords,
        { workspaceId },
      );
      return;
    }
  }
}

export const deleteArchivedRecords = mutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    await deleteArchivedBatch(ctx, args.workspaceId);
  },
});

export const continueDeleteArchivedRecords = internalMutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    await deleteArchivedBatch(ctx, args.workspaceId);
  },
});
