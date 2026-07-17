import { expect, test, beforeEach } from "vitest";
import {
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  siteUrl,
} from "../../../grader";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "004-actions";
const EVAL_NAME = "009-webhook_state_machine";
const ENDPOINT = `${siteUrl}/webhooks/billing`;

type Status = "applied" | "ignored" | "duplicate";
type SubscriptionState = "active" | "past_due" | "canceled";

interface EventBody {
  eventId: string;
  subscriptionId: string;
  sequence: number;
  state: SubscriptionState;
}

interface Subscription {
  subscriptionId: string;
  state: SubscriptionState;
  sequence: number;
}

interface Receipt {
  eventId: string;
  outcome: "applied" | "ignored";
  _creationTime: number;
}

async function post(
  body: unknown,
): Promise<{ status: number; contentType: string; json: unknown }> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (contentType.includes("application/json")) {
    json = await response.json();
  } else {
    await response.text();
  }
  return { status: response.status, contentType, json };
}

async function deliver(event: EventBody): Promise<Status> {
  const { status, contentType, json } = await post(event);
  expect(status, `event ${event.eventId} should be accepted`).toBe(200);
  expect(contentType).toContain("application/json");
  const value = (json as { status?: unknown })?.status;
  expect(["applied", "ignored", "duplicate"]).toContain(value);
  return value as Status;
}

async function getSubscriptions(): Promise<Subscription[]> {
  return (await listTable(
    responseAdminClient,
    "subscriptions",
  )) as unknown as Subscription[];
}

async function getReceipts(): Promise<Receipt[]> {
  return (await listTable(
    responseAdminClient,
    "receipts",
  )) as unknown as Receipt[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["subscriptions", "receipts"]);
});

test("first events create and advance subscriptions", async () => {
  expect(
    await deliver({
      eventId: "evt-1",
      subscriptionId: "sub-A",
      sequence: 1,
      state: "active",
    }),
  ).toBe("applied");

  let subs = await getSubscriptions();
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({
    subscriptionId: "sub-A",
    state: "active",
    sequence: 1,
  });

  expect(
    await deliver({
      eventId: "evt-2",
      subscriptionId: "sub-A",
      sequence: 2,
      state: "past_due",
    }),
  ).toBe("applied");

  subs = await getSubscriptions();
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({
    subscriptionId: "sub-A",
    state: "past_due",
    sequence: 2,
  });

  const receipts = await getReceipts();
  expect(receipts).toHaveLength(2);
  expect(receipts.every((r) => r.outcome === "applied")).toBe(true);
});

test("duplicate eventId takes precedence and mutates nothing", async () => {
  const original: EventBody = {
    eventId: "evt-dup",
    subscriptionId: "sub-B",
    sequence: 5,
    state: "active",
  };
  expect(await deliver(original)).toBe("applied");

  // Exact replay.
  expect(await deliver(original)).toBe("duplicate");

  // Same eventId, conflicting payload: still duplicate, still no effects -
  // no new receipt, no new subscription, no state/sequence change.
  expect(
    await deliver({
      eventId: "evt-dup",
      subscriptionId: "sub-OTHER",
      sequence: 99,
      state: "canceled",
    }),
  ).toBe("duplicate");

  const subs = await getSubscriptions();
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({
    subscriptionId: "sub-B",
    state: "active",
    sequence: 5,
  });
  const receipts = await getReceipts();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ eventId: "evt-dup", outcome: "applied" });

  // Replaying an event that was originally IGNORED is also a duplicate, even
  // if the replay now carries a sequence that would have applied.
  expect(
    await deliver({
      eventId: "evt-stale",
      subscriptionId: "sub-B",
      sequence: 3,
      state: "canceled",
    }),
  ).toBe("ignored");
  expect(
    await deliver({
      eventId: "evt-stale",
      subscriptionId: "sub-B",
      sequence: 100,
      state: "canceled",
    }),
  ).toBe("duplicate");
  expect(await getSubscriptions()).toHaveLength(1);
  expect((await getSubscriptions())[0].sequence).toBe(5);
  expect(await getReceipts()).toHaveLength(2);
});

test("stale and equal sequences are ignored with receipts", async () => {
  expect(
    await deliver({
      eventId: "evt-10",
      subscriptionId: "sub-C",
      sequence: 10,
      state: "active",
    }),
  ).toBe("applied");

  expect(
    await deliver({
      eventId: "evt-9",
      subscriptionId: "sub-C",
      sequence: 9,
      state: "canceled",
    }),
  ).toBe("ignored");

  expect(
    await deliver({
      eventId: "evt-10b",
      subscriptionId: "sub-C",
      sequence: 10,
      state: "canceled",
    }),
  ).toBe("ignored");

  const subs = await getSubscriptions();
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({
    subscriptionId: "sub-C",
    state: "active",
    sequence: 10,
  });

  const receipts = await getReceipts();
  expect(receipts).toHaveLength(3);
  const ignored = receipts.filter((r) => r.outcome === "ignored");
  expect(ignored.map((r) => r.eventId).sort()).toEqual(["evt-10b", "evt-9"]);
});

test("invalid JSON and invalid shapes get 400 without effects", async () => {
  const badBodies: unknown[] = [
    "{ not json",
    {},
    { eventId: "e", subscriptionId: "s", sequence: 1 },
    { eventId: "e", subscriptionId: "s", sequence: "1", state: "active" },
    { eventId: "e", subscriptionId: "s", sequence: 1, state: "paused" },
    { eventId: 7, subscriptionId: "s", sequence: 1, state: "active" },
  ];
  for (const body of badBodies) {
    const { status, contentType } = await post(body);
    expect(status, `body ${JSON.stringify(body)} must be rejected`).toBe(400);
    expect(contentType, "rejections must also be JSON responses").toContain(
      "application/json",
    );
  }
  expect(await getSubscriptions()).toHaveLength(0);
  expect(await getReceipts()).toHaveLength(0);
});

test(
  "concurrent identical deliveries apply exactly once",
  { timeout: 60_000 },
  async () => {
    for (let round = 0; round < 5; round++) {
      const event: EventBody = {
        eventId: `evt-race-${round}`,
        subscriptionId: `sub-race-${round}`,
        sequence: 1,
        state: "active",
      };
      const [a, b] = await Promise.all([deliver(event), deliver(event)]);
      expect([a, b].sort()).toEqual(["applied", "duplicate"]);

      const receipts = (await getReceipts()).filter(
        (r) => r.eventId === event.eventId,
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0].outcome).toBe("applied");

      const subs = (await getSubscriptions()).filter(
        (s) => s.subscriptionId === event.subscriptionId,
      );
      expect(subs).toHaveLength(1);
      expect(subs[0].sequence).toBe(1);
    }
  },
);

test(
  "concurrent out-of-order deliveries never regress a subscription",
  { timeout: 60_000 },
  async () => {
    for (let round = 0; round < 5; round++) {
      const subscriptionId = `sub-ooo-${round}`;
      const high: EventBody = {
        eventId: `evt-high-${round}`,
        subscriptionId,
        sequence: 10,
        state: "canceled",
      };
      const low: EventBody = {
        eventId: `evt-low-${round}`,
        subscriptionId,
        sequence: 5,
        state: "active",
      };
      const [highStatus, lowStatus] = await Promise.all([
        deliver(high),
        deliver(low),
      ]);

      // The higher sequence must always win; the lower one may have applied
      // first or been ignored, depending on serialization order.
      expect(highStatus).toBe("applied");
      expect(["applied", "ignored"]).toContain(lowStatus);

      const subs = (await getSubscriptions()).filter(
        (s) => s.subscriptionId === subscriptionId,
      );
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ state: "canceled", sequence: 10 });

      const receipts = (await getReceipts()).filter((r) =>
        [high.eventId, low.eventId].includes(r.eventId),
      );
      expect(receipts).toHaveLength(2);

      // Replay both after the race: pure duplicates, no effect.
      expect(await deliver(high)).toBe("duplicate");
      expect(await deliver(low)).toBe("duplicate");
      expect(
        (await getReceipts()).filter((r) =>
          [high.eventId, low.eventId].includes(r.eventId),
        ),
      ).toHaveLength(2);
    }

    // Across everything this test delivered, applied sequences sorted by
    // receipt creation time must never decrease per subscription.
    const sequenceByEventId = new Map<string, number>();
    const subByEventId = new Map<string, string>();
    for (let round = 0; round < 5; round++) {
      sequenceByEventId.set(`evt-high-${round}`, 10);
      sequenceByEventId.set(`evt-low-${round}`, 5);
      subByEventId.set(`evt-high-${round}`, `sub-ooo-${round}`);
      subByEventId.set(`evt-low-${round}`, `sub-ooo-${round}`);
    }
    const applied = (await getReceipts())
      .filter((r) => r.outcome === "applied")
      .sort((a, b) => a._creationTime - b._creationTime);
    const lastBySub = new Map<string, number>();
    for (const receipt of applied) {
      const sub = subByEventId.get(receipt.eventId)!;
      const seq = sequenceByEventId.get(receipt.eventId)!;
      const last = lastBySub.get(sub) ?? -Infinity;
      expect(
        seq,
        `applied sequences must not decrease (subscription ${sub})`,
      ).toBeGreaterThanOrEqual(last);
      lastBySub.set(sub, seq);
    }
  },
);

test("the HTTP path commits through a single internal mutation", () => {
  const compose = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...compose(full));
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
        files.push(full);
    }
    return files;
  };
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const sources = compose(convexDir).map((file) =>
    ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );

  // Aliases for internal.* references, so `const fn = internal.x.y;` and
  // `const { fn } = internal.x;` still count as targeting internal functions.
  const internalRefs = new Set<string>();
  for (const source of sources) {
    const collectAliases = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (node.initializer.getText() === "internal" ||
          node.initializer.getText().startsWith("internal."))
      ) {
        if (ts.isIdentifier(node.name)) {
          internalRefs.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (ts.isIdentifier(element.name)) {
              internalRefs.add(element.name.text);
            }
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }

  let runQueryCalls = 0;
  let runMutationCalls = 0;
  let internalMutationTargets = 0;
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : "";
        if (name === "runQuery") runQueryCalls++;
        if (name === "runMutation") {
          runMutationCalls++;
          const target = node.arguments[0];
          if (
            target !== undefined &&
            (target.getText().startsWith("internal.") ||
              (ts.isIdentifier(target) && internalRefs.has(target.text)))
          ) {
            internalMutationTargets++;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // The dedup decision and the state update must live in one transaction:
  // no reads from the HTTP action, and exactly one mutation entry point.
  expect(
    runQueryCalls,
    "the HTTP action must not read state via runQuery - the dedup decision belongs inside the mutation",
  ).toBe(0);
  expect(
    runMutationCalls,
    "all database effects must go through exactly one runMutation call",
  ).toBe(1);
  expect(
    internalMutationTargets,
    "the mutation the HTTP action invokes must be internal",
  ).toBe(1);
});
