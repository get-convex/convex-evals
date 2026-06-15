import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { stepNameLiteral, stepStatus } from "./schema.js";

export const recordStep = internalMutation({
  args: {
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  },
  returns: v.id("steps"),
  handler: async (ctx, args) => {
    // Transition eval to "running" on first step if it's still pending
    const evalDoc = await ctx.db.get("evals", args.evalId);
    if (evalDoc && evalDoc.status.kind === "pending") {
      await ctx.db.patch("evals", args.evalId, {
        status: { kind: "running" as const },
      });
    }

    const id = await ctx.db.insert("steps", {
      evalId: args.evalId,
      name: args.name,
      status: args.status,
    });
    return id;
  },
});
