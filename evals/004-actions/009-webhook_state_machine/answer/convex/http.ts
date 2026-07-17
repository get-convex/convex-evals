import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const SUBSCRIPTION_STATES = ["active", "past_due", "canceled"] as const;
type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const http = httpRouter();

http.route({
  path: "/webhooks/billing",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    if (parsed === null || typeof parsed !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }
    const body = parsed as Record<string, unknown>;
    const { eventId, subscriptionId, sequence, state } = body;
    if (
      typeof eventId !== "string" ||
      typeof subscriptionId !== "string" ||
      typeof sequence !== "number" ||
      typeof state !== "string" ||
      !SUBSCRIPTION_STATES.includes(state as SubscriptionState)
    ) {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const status = await ctx.runMutation(internal.index.processBillingEvent, {
      eventId,
      subscriptionId,
      sequence,
      state: state as SubscriptionState,
    });
    return jsonResponse({ status }, 200);
  }),
});

export default http;
