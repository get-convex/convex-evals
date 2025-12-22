import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["teams", "users"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getTeamsWithDeletedAdmins returns empty array when no teams exist", async () => {
  const teams = await responseClient.query(
    api.index.getTeamsWithDeletedAdmins,
    {},
  );
  expect(teams).toEqual([]);
});

test("getTeamsWithDeletedAdmins returns empty array when no admins are deleted", async () => {
  // Create active users
  await addDocuments(responseAdminClient, "users", [
    { name: "Active User 1", deleted: false },
    { name: "Active User 2", deleted: false },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const [user1Id, user2Id] = users.slice(-2).map((u) => u._id);

  // Create teams with active admins
  await addDocuments(responseAdminClient, "teams", [
    { name: "Team 1", adminId: user1Id },
    { name: "Team 2", adminId: user2Id },
  ]);

  const teams = await responseClient.query(
    api.index.getTeamsWithDeletedAdmins,
    {},
  );
  expect(teams).toEqual([]);
});

test("getTeamsWithDeletedAdmins correctly identifies teams with deleted admins", async () => {
  // Create mix of active and deleted users
  await addDocuments(responseAdminClient, "users", [
    { name: "Active User", deleted: false },
    { name: "Deleted User", deleted: true },
    { name: "Another Active User", deleted: false },
    { name: "Another Deleted User", deleted: true },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const [activeUser1, deletedUser1, activeUser2, deletedUser2] = users
    .slice(-4)
    .map((u) => u._id);

  // Create teams with mix of admin states
  await addDocuments(responseAdminClient, "teams", [
    { name: "Team 1", adminId: activeUser1 },
    { name: "Team 2", adminId: deletedUser1 },
    { name: "Team 3", adminId: activeUser2 },
    { name: "Team 4", adminId: deletedUser2 },
  ]);
  const teams = (await listTable(
    responseAdminClient,
    "teams",
  )) as Doc<"teams">[];

  const teamsWithDeletedAdmins = await responseClient.query(
    api.index.getTeamsWithDeletedAdmins,
    {},
  );

  // Should only return teams with deleted admins
  expect(teamsWithDeletedAdmins).toHaveLength(2);
  expect(teamsWithDeletedAdmins).toContain(teams[1]._id); // Team 2
  expect(teamsWithDeletedAdmins).toContain(teams[3]._id); // Team 4
});

test("getTeamsWithDeletedAdmins handles missing admin users", async () => {
  // Create a user
  await addDocuments(responseAdminClient, "users", [
    { name: "Existing User", deleted: true },
  ]);
  const user = (
    await listTable(responseAdminClient, "users")
  )[0] as Doc<"users">;

  await deleteAllDocuments(responseAdminClient, ["users"]);

  // Create teams with mix of existing and non-existing admin IDs
  await addDocuments(responseAdminClient, "teams", [
    { name: "Team 1", adminId: user._id },
  ]);

  const teamsWithDeletedAdmins = await responseClient.query(
    api.index.getTeamsWithDeletedAdmins,
    {},
  );

  // Should not include teams with non-existent admins
  expect(teamsWithDeletedAdmins).toHaveLength(0);
});
