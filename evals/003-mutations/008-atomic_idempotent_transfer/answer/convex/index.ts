import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const transfer = mutation({
  args: {
    fromAccountId: v.id("accounts"),
    toAccountId: v.id("accounts"),
    amount: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    // The idempotency check runs first so that replaying a completed
    // transfer succeeds even if balances have since changed.
    const existing = await ctx.db
      .query("transfers")
      .withIndex("by_idempotencyKey", (q) =>
        q.eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.fromAccountId !== args.fromAccountId ||
        existing.toAccountId !== args.toAccountId ||
        existing.amount !== args.amount
      ) {
        throw new Error(
          "Idempotency key was already used with different transfer details",
        );
      }
      return existing._id;
    }

    // Number.isFinite also rejects NaN, which would otherwise pass `<= 0`
    // and corrupt both balances.
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new Error("Transfer amount must be a positive, finite number");
    }
    if (args.fromAccountId === args.toAccountId) {
      throw new Error("Cannot transfer to the same account");
    }
    const from = await ctx.db.get("accounts", args.fromAccountId);
    if (from === null) {
      throw new Error("Debit account not found");
    }
    const to = await ctx.db.get("accounts", args.toAccountId);
    if (to === null) {
      throw new Error("Credit account not found");
    }
    if (from.balance < args.amount) {
      throw new Error("Insufficient balance");
    }

    await ctx.db.patch("accounts", args.fromAccountId, {
      balance: from.balance - args.amount,
    });
    await ctx.db.patch("accounts", args.toAccountId, {
      balance: to.balance + args.amount,
    });
    return await ctx.db.insert("transfers", {
      fromAccountId: args.fromAccountId,
      toAccountId: args.toAccountId,
      amount: args.amount,
      idempotencyKey: args.idempotencyKey,
    });
  },
});
