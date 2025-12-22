import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get pro admins by org returns empty object when no admins exist", async () => {
  // Create an organization first
  await addDocuments(responseAdminClient, "organizations", [
    { name: "Empty Org" },
  ]);
  const orgs = await listTable(responseAdminClient, "organizations");
  const orgId = orgs[0]._id;

  const admins = await responseClient.query(api.public.getProAdminsByOrg, {
    organizationId: orgId,
  });
  expect(admins).toEqual({});
});

test("get pro admins by org returns correct admin mapping", async () => {
  // Create test data with multiple organizations, teams, and users
  await addDocuments(responseAdminClient, "organizations", [
    { name: "Org 1" },
    { name: "Org 2" },
  ]);
  const orgs = await listTable(responseAdminClient, "organizations");
  const [org1Id, org2Id] = orgs; // listTable returns in chronological order

  await addDocuments(responseAdminClient, "teams", [
    { organizationId: org1Id._id, name: "Team 1" },
    { organizationId: org1Id._id, name: "Team 2" },
    { organizationId: org2Id._id, name: "Team 3" },
  ]);
  const teams = await listTable(responseAdminClient, "teams");
  const [team1Id, team2Id, team3Id] = teams;

  await addDocuments(responseAdminClient, "users", [
    { name: "Alice", profileUrl: "alice.jpg" },
    { name: "Bob", profileUrl: "bob.jpg" },
    { name: "Charlie", profileUrl: "charlie.jpg" },
    { name: "David", profileUrl: "david.jpg" },
  ]);
  const users = await listTable(responseAdminClient, "users");
  const [user1Id, user2Id, user3Id, user4Id] = users;

  // Create team memberships with different roles
  await addDocuments(responseAdminClient, "teamMembers", [
    // Org 1, Team 1
    { teamId: team1Id._id, userId: user1Id._id, role: "admin" },
    { teamId: team1Id._id, userId: user2Id._id, role: "member" },

    // Org 1, Team 2
    { teamId: team2Id._id, userId: user2Id._id, role: "admin" },
    { teamId: team2Id._id, userId: user3Id._id, role: "admin" },

    // Org 2, Team 3
    { teamId: team3Id._id, userId: user4Id._id, role: "admin" },
  ]);

  // Test getting admins for org1
  const org1Admins = await responseClient.query(api.public.getProAdminsByOrg, {
    organizationId: org1Id._id,
  });

  // Should include Alice, Bob, and Charlie (unique admins across both teams)
  expect(Object.keys(org1Admins)).toHaveLength(3);
  expect(org1Admins[user1Id._id]).toBe("alice.jpg");
  expect(org1Admins[user2Id._id]).toBe("bob.jpg");
  expect(org1Admins[user3Id._id]).toBe("charlie.jpg");
  expect(org1Admins[user4Id._id]).toBeUndefined();

  // Test getting admins for org2
  const org2Admins = await responseClient.query(api.public.getProAdminsByOrg, {
    organizationId: org2Id._id,
  });

  // Should only include David
  expect(Object.keys(org2Admins)).toHaveLength(1);
  expect(org2Admins[user4Id._id]).toBe("david.jpg");
});
