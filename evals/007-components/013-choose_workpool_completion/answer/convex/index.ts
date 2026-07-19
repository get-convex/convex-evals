import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";

const processingPool = new Workpool(components.workpool, {
  maxParallelism: 5,
});

export const startProcessing = mutation({
  args: {
    filename: v.string(),
  },
  handler: async (ctx, args) => {
    const uploadId = await ctx.db.insert("uploads", {
      filename: args.filename,
      status: "queued",
    });
    await processingPool.enqueueMutation(
      ctx,
      internal.index.processUpload,
      { uploadId },
      {
        // The audit row is written by the completion callback: it fires for
        // success AND failure, while a job that throws writes nothing.
        onComplete: internal.index.recordOutcome,
        context: uploadId,
      },
    );
    return uploadId;
  },
});

export const processUpload = internalMutation({
  args: {
    uploadId: v.id("uploads"),
  },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get("uploads", args.uploadId);
    if (upload === null) {
      throw new Error("Upload no longer exists");
    }
    await ctx.db.patch("uploads", args.uploadId, { status: "processed" });
  },
});

export const recordOutcome = internalMutation({
  args: vOnCompleteArgs(v.id("uploads")),
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLog", {
      uploadId: args.context,
      outcome: args.result.kind === "success" ? "success" : "failure",
    });
  },
});
