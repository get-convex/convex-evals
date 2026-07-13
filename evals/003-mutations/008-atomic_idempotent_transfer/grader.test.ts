import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["transfers", "accounts"]);
});

async function seedAccounts(
  balances: number[],
): Promise<Id<"accounts">[]> {
  await addDocuments(
    responseAdminClient,
    "accounts",
    balances.map((balance, i) => ({ name: `account-${i}`, balance })),
  );
  const accounts = (await listTable(
    responseAdminClient,
    "accounts",
  )) as Doc<"accounts">[];
  return balances.map(
    (_, i) => accounts.find((a) => a.name === `account-${i}`)!._id,
  );
}

async function getBalance(accountId: Id<"accounts">): Promise<number> {
  const accounts = (await listTable(
    responseAdminClient,
    "accounts",
  )) as Doc<"accounts">[];
  return accounts.find((a) => a._id === accountId)!.balance;
}

async function getTransfers(): Promise<Doc<"transfers">[]> {
  return (await listTable(
    responseAdminClient,
    "transfers",
  )) as Doc<"transfers">[];
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("successful transfer moves money and records one transfer", async () => {
  const [a, b] = await seedAccounts([100, 50]);

  const transferId = await responseClient.mutation(api.index.transfer, {
    fromAccountId: a,
    toAccountId: b,
    amount: 60,
    idempotencyKey: "key-1",
  });

  expect(transferId).toBeDefined();
  expect(await getBalance(a)).toBe(40);
  expect(await getBalance(b)).toBe(110);

  const transfers = await getTransfers();
  expect(transfers).toHaveLength(1);
  expect(transfers[0]._id).toBe(transferId);
  expect(transfers[0]).toMatchObject({
    fromAccountId: a,
    toAccountId: b,
    amount: 60,
    idempotencyKey: "key-1",
  });
});

test("rejects zero and negative amounts without side effects", async () => {
  const [a, b] = await seedAccounts([100, 50]);

  for (const amount of [0, -25]) {
    await expect(
      responseClient.mutation(api.index.transfer, {
        fromAccountId: a,
        toAccountId: b,
        amount,
        idempotencyKey: `bad-amount-${amount}`,
      }),
    ).rejects.toThrow();
  }

  expect(await getBalance(a)).toBe(100);
  expect(await getBalance(b)).toBe(50);
  expect(await getTransfers()).toHaveLength(0);
});

test("rejects transfers involving a missing account", async () => {
  const [a, b] = await seedAccounts([100, 50]);
  // Invalidate the seeded IDs, then recreate one live account.
  await deleteAllDocuments(responseAdminClient, ["accounts"]);
  const [c] = await seedAccounts([100]);

  await expect(
    responseClient.mutation(api.index.transfer, {
      fromAccountId: a,
      toAccountId: c,
      amount: 10,
      idempotencyKey: "missing-from",
    }),
  ).rejects.toThrow();

  await expect(
    responseClient.mutation(api.index.transfer, {
      fromAccountId: c,
      toAccountId: b,
      amount: 10,
      idempotencyKey: "missing-to",
    }),
  ).rejects.toThrow();

  expect(await getBalance(c)).toBe(100);
  expect(await getTransfers()).toHaveLength(0);
});

test("rejects a transfer to the same account", async () => {
  const [a] = await seedAccounts([100]);

  await expect(
    responseClient.mutation(api.index.transfer, {
      fromAccountId: a,
      toAccountId: a,
      amount: 10,
      idempotencyKey: "same-account",
    }),
  ).rejects.toThrow();

  expect(await getBalance(a)).toBe(100);
  expect(await getTransfers()).toHaveLength(0);
});

test("rejects insufficient funds without side effects", async () => {
  const [a, b] = await seedAccounts([30, 0]);

  await expect(
    responseClient.mutation(api.index.transfer, {
      fromAccountId: a,
      toAccountId: b,
      amount: 31,
      idempotencyKey: "too-much",
    }),
  ).rejects.toThrow();

  expect(await getBalance(a)).toBe(30);
  expect(await getBalance(b)).toBe(0);
  expect(await getTransfers()).toHaveLength(0);
});

test("identical replay returns the original transfer ID without moving money", async () => {
  const [a, b] = await seedAccounts([100, 0]);

  const originalId = await responseClient.mutation(api.index.transfer, {
    fromAccountId: a,
    toAccountId: b,
    amount: 60,
    idempotencyKey: "key-1",
  });
  expect(await getBalance(a)).toBe(40);

  // Drain the debit account below the original amount so a re-executed
  // transfer could not succeed on its own.
  const secondId = await responseClient.mutation(api.index.transfer, {
    fromAccountId: a,
    toAccountId: b,
    amount: 30,
    idempotencyKey: "key-2",
  });
  expect(secondId).not.toBe(originalId);
  expect(await getBalance(a)).toBe(10);

  const replayedId = await responseClient.mutation(api.index.transfer, {
    fromAccountId: a,
    toAccountId: b,
    amount: 60,
    idempotencyKey: "key-1",
  });

  expect(replayedId).toBe(originalId);
  expect(await getBalance(a)).toBe(10);
  expect(await getBalance(b)).toBe(90);
  expect(await getTransfers()).toHaveLength(2);
});

test("replay with different transfer details throws", async () => {
  const [a, b, c] = await seedAccounts([100, 0, 0]);

  await responseClient.mutation(api.index.transfer, {
    fromAccountId: a,
    toAccountId: b,
    amount: 10,
    idempotencyKey: "key-1",
  });

  const conflictingPayloads = [
    { fromAccountId: a, toAccountId: b, amount: 20 }, // different amount
    { fromAccountId: a, toAccountId: c, amount: 10 }, // different recipient
    { fromAccountId: c, toAccountId: b, amount: 10 }, // different sender
  ];
  for (const payload of conflictingPayloads) {
    await expect(
      responseClient.mutation(api.index.transfer, {
        ...payload,
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow();
  }

  expect(await getBalance(a)).toBe(90);
  expect(await getBalance(b)).toBe(10);
  expect(await getBalance(c)).toBe(0);
  expect(await getTransfers()).toHaveLength(1);
});

test(
  "concurrent identical calls move money exactly once",
  { timeout: 30_000 },
  async () => {
    const [a, b] = await seedAccounts([100, 0]);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        responseClient.mutation(api.index.transfer, {
          fromAccountId: a,
          toAccountId: b,
          amount: 60,
          idempotencyKey: "concurrent-key",
        }),
      ),
    );

    // Every call returns the same transfer ID...
    expect(new Set(results).size).toBe(1);

    // ...money moved exactly once...
    expect(await getBalance(a)).toBe(40);
    expect(await getBalance(b)).toBe(60);

    // ...and exactly one ledger row exists.
    const transfers = await getTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]._id).toBe(results[0]);
  },
);
