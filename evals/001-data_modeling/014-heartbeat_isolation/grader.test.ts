import { beforeEach, expect, test } from "vitest";
import {
  addDocuments,
  deleteAllDocuments,
  getSchema,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";

type UserRow = {
  _id: string;
  name: string;
  email: string;
};

type PresenceRow = {
  _id: string;
  userId: string;
  lastHeartbeatMs: number;
};

type OnlineUser = {
  userId: string;
  name: string;
  email: string;
  lastHeartbeatMs: number;
};

type SchemaTable = {
  tableName: string;
  documentType: unknown;
  indexes: { indexDescriptor: string; fields: string[] }[];
};

const profiles = [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
];

async function seedUsers(
  extraProfiles: typeof profiles = [],
): Promise<UserRow[]> {
  await addDocuments(responseAdminClient, "users", [
    ...profiles,
    ...extraProfiles,
  ]);
  return listTable(responseAdminClient, "users", 100);
}

async function heartbeat(userId: string, nowMs: number): Promise<void> {
  await responseClient.mutation(anyApi.index.recordHeartbeat, {
    userId,
    nowMs,
  });
}

async function presenceRows(): Promise<PresenceRow[]> {
  return listTable(responseAdminClient, "userPresence", 100);
}

function byId<T extends { _id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a._id.localeCompare(b._id));
}

beforeEach(async () => {
  const schema = await getSchema(responseAdminClient);
  const tables: SchemaTable[] = schema?.tables ?? [];
  await deleteAllDocuments(
    responseAdminClient,
    tables.map((table) => table.tableName),
  );
});

test("deployed schema preserves users and declares userPresence", async () => {
  const schema = await getSchema(responseAdminClient);
  const tables: SchemaTable[] = schema?.tables ?? [];
  const users = tables.find((table) => table.tableName === "users");
  const presence = tables.find((table) => table.tableName === "userPresence");

  // Inspect the deployed validator, so aliases and composed schema declarations
  // work and an extra heartbeat field cannot hide behind an unexpected name.
  expect(users?.documentType).toEqual({
    type: "object",
    value: {
      name: { fieldType: { type: "string" }, optional: false },
      email: { fieldType: { type: "string" }, optional: false },
    },
  });
  const emailIndex = users?.indexes.find(
    (index) => index.indexDescriptor === "by_email",
  );
  // The backend appends _creationTime to each index as a tie-breaker.
  expect(
    emailIndex?.fields.filter((field) => field !== "_creationTime"),
  ).toEqual(["email"]);
  expect(presence?.documentType).toMatchObject({
    type: "object",
    value: {
      userId: {
        fieldType: { type: "id", tableName: "users" },
        optional: false,
      },
      lastHeartbeatMs: { fieldType: { type: "number" }, optional: false },
    },
  });
});

test("listOnlineUsers returns empty when there are no heartbeats", async () => {
  const args = { activeWithinMs: 60_000, nowMs: 1_000_000 };
  expect(
    await responseClient.query(anyApi.index.listOnlineUsers, args),
  ).toEqual([]);

  await seedUsers();
  expect(
    await responseClient.query(anyApi.index.listOnlineUsers, args),
  ).toEqual([]);
});

test("heartbeats update the same presence record independently for each user", async () => {
  const users = await seedUsers();
  const alice = users.find((user) => user.email === profiles[0].email)!;
  const bob = users.find((user) => user.email === profiles[1].email)!;

  await heartbeat(alice._id, 1_000);
  const initialRows = await presenceRows();
  expect(initialRows).toHaveLength(1);
  expect(initialRows[0]).toMatchObject({
    userId: alice._id,
    lastHeartbeatMs: 1_000,
  });
  const alicePresenceId = initialRows[0]._id;

  await heartbeat(bob._id, 1_500);
  const twoRows = await presenceRows();
  expect(twoRows).toHaveLength(2);
  expect(twoRows.find((row) => row.userId === alice._id)).toMatchObject({
    _id: alicePresenceId,
    lastHeartbeatMs: 1_000,
  });
  const bobPresence = twoRows.find((row) => row.userId === bob._id)!;
  expect(bobPresence).toMatchObject({ lastHeartbeatMs: 1_500 });

  await heartbeat(alice._id, 2_000);
  await heartbeat(alice._id, 2_000);
  const afterAlice = await presenceRows();
  expect(afterAlice).toHaveLength(2);
  expect(afterAlice.find((row) => row.userId === alice._id)).toMatchObject({
    _id: alicePresenceId,
    lastHeartbeatMs: 2_000,
  });
  expect(afterAlice.find((row) => row.userId === bob._id)).toEqual(bobPresence);

  await heartbeat(bob._id, 2_500);
  const afterBob = await presenceRows();
  expect(afterBob).toHaveLength(2);
  expect(afterBob.find((row) => row.userId === bob._id)).toMatchObject({
    _id: bobPresence._id,
    lastHeartbeatMs: 2_500,
  });
  expect(afterBob.find((row) => row.userId === alice._id)).toEqual(
    afterAlice.find((row) => row.userId === alice._id),
  );
});

test("recording heartbeats leaves every stored user document unchanged", async () => {
  const users = await seedUsers();
  // Keep complete documents, including IDs and creation times. Comparing only
  // name/email would miss an added timestamp or a deleted/recreated profile.
  const before = byId(users);
  for (const [user, nowMs] of [
    [users[0], 1_000],
    [users[0], 2_000],
    [users[1], 3_000],
  ] as const) {
    await heartbeat(user._id, nowMs);
    expect(byId(await listTable(responseAdminClient, "users", 100))).toEqual(
      before,
    );
  }
});

test("listOnlineUsers returns complete profiles at the inclusive heartbeat threshold", async () => {
  const users = await seedUsers([
    { name: "Cara", email: "cara@example.com" },
    { name: "Dee", email: "dee@example.com" },
  ]);
  const alice = users.find((user) => user.email === profiles[0].email)!;
  const bob = users.find((user) => user.email === profiles[1].email)!;
  const cara = users.find((user) => user.email === "cara@example.com")!;
  const beats = [
    { user: alice, time: 9_800 },
    { user: bob, time: 9_799 },
    { user: cara, time: 9_990 },
  ];
  for (const { user, time } of beats) await heartbeat(user._id, time);

  // Check both sides of the cutoff, a second window, and expiry. No timing
  // assumptions or sleeps are needed because the caller supplies the clock.
  for (const args of [
    { activeWithinMs: 200, nowMs: 10_000 },
    { activeWithinMs: 500, nowMs: 10_000 },
    { activeWithinMs: 200, nowMs: 10_200 },
  ]) {
    const result: OnlineUser[] = await responseClient.query(
      anyApi.index.listOnlineUsers,
      args,
    );
    const expected = beats
      .filter(({ time }) => time >= args.nowMs - args.activeWithinMs)
      .map(({ user, time }) => ({
        userId: user._id,
        name: user.name,
        email: user.email,
        lastHeartbeatMs: time,
      }));
    expect(
      [...result].sort((a, b) => a.userId.localeCompare(b.userId)),
    ).toEqual(expected.sort((a, b) => a.userId.localeCompare(b.userId)));
  }
});
