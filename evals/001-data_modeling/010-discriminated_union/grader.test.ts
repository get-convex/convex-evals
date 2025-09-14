import { expect, test } from "vitest";
import { responseAdminClient, addDocuments } from "../../../grader";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("schema validates different notification types correctly", async () => {
  // Valid notifications
  await expect(
    addDocuments(responseAdminClient, "notifications", [
      {
        kind: "message",
        senderId: "user1",
        messageText: "Hello!",
      },
      {
        kind: "friendRequest",
        requesterId: "user2",
      },
      {
        kind: "achievement",
        achievementName: "First Post",
        points: 100,
      },
    ]),
  ).resolves.toBeUndefined();

  // Invalid notifications
  await expect(
    addDocuments(responseAdminClient, "notifications", [
      {
        kind: "message",
        // Missing required fields
      },
    ]),
  ).rejects.toThrow();

  await expect(
    addDocuments(responseAdminClient, "notifications", [
      {
        kind: "friendRequest",
        requesterId: "user2",
        // Extra field should fail
        extraField: "invalid",
      },
    ]),
  ).rejects.toThrow();

  await expect(
    addDocuments(responseAdminClient, "notifications", [
      {
        kind: "achievement",
        achievementName: "Invalid",
        points: "100", // Wrong kind for points
      },
    ]),
  ).rejects.toThrow();

  await expect(
    addDocuments(responseAdminClient, "notifications", [
      {
        kind: "invalidType", // Invalid notification kind
        data: "something",
      },
    ]),
  ).rejects.toThrow();
});
