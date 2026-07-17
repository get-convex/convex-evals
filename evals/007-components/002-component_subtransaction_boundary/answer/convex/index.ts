import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";

export const recordAudit = mutation({
  args: {
    event: v.string(),
    shouldFail: v.boolean(),
  },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(components.auditSink.index.writeAudit, {
        event: args.event,
        failAfterWrite: args.shouldFail,
      });
    } catch {
      // The component call is a subtransaction: its audit insert rolled
      // back on the throw, while this mutation continues and commits the
      // failure status.
      await ctx.db.insert("auditStatuses", {
        event: args.event,
        status: "audit_failed",
      });
      return "audit_failed";
    }
    await ctx.db.insert("auditStatuses", {
      event: args.event,
      status: "audit_succeeded",
    });
    return "audit_succeeded";
  },
});

export const getAuditCount = query({
  args: {
    event: v.string(),
  },
  handler: async (ctx, args) => {
    const count: number = await ctx.runQuery(
      components.auditSink.index.countAudits,
      { event: args.event },
    );
    return count;
  },
});
