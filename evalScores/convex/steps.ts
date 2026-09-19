import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { stepNameLiteral, stepStatus } from "./schema.js";
import { requireCodingEval, requireCodingRun } from "./documentKinds.js";

export const recordStep = internalMutation({
  args: {
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  },
  returns: v.id("steps"),
  handler: async (ctx, args) => {
    // Transition eval to "running" on first step if it's still pending
    const storedEval = await ctx.db.get("evals", args.evalId);
    if (!storedEval) throw new Error(`Eval ${args.evalId} not found`);
    const evalDoc = requireCodingEval(storedEval);
    const storedRun = await ctx.db.get("runs", evalDoc.runId);
    if (!storedRun) throw new Error(`Run ${evalDoc.runId} not found`);
    requireCodingRun(storedRun);

    if (evalDoc.status.kind === "pending") {
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
