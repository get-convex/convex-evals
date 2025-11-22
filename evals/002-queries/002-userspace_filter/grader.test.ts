import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get popular pinned messages returns empty array when no messages exist", async () => {
  const messages = await responseClient.query(
    anyApi.public.getPopularPinnedMessages,
    {
      author: "alice",
      minLikes: 5,
    },
  );
  expect(messages).toEqual([]);
});

test("get popular pinned messages filters and sorts correctly", async () => {
  // Load test data with mix of pinned/unpinned and varying likes
  const testMessages = [
    { author: "alice", text: "Popular pinned", likes: 10, isPinned: true },
    { author: "alice", text: "Very popular pinned", likes: 15, isPinned: true },
    { author: "alice", text: "Unpopular pinned", likes: 3, isPinned: true },
    { author: "alice", text: "Popular unpinned", likes: 12, isPinned: false },
    { author: "alice", text: "Unpopular unpinned", likes: 2, isPinned: false },
    { author: "bob", text: "Other author", likes: 20, isPinned: true },
  ];
  await addDocuments(responseAdminClient, "messages", testMessages);

  // Test with minLikes = 5
  const popularMessages = await responseClient.query(
    anyApi.public.getPopularPinnedMessages,
    {
      author: "alice",
      minLikes: 5,
    },
  );

  // Should only return pinned messages with >= 5 likes, sorted by likes
  expect(popularMessages).toHaveLength(2);
  expect(popularMessages[0].text).toBe("Very popular pinned");
  expect(popularMessages[1].text).toBe("Popular pinned");

  // Verify all fields are present
  for (const msg of popularMessages) {
    expect(msg).toHaveProperty("_id");
    expect(msg).toHaveProperty("_creationTime");
    expect(msg).toHaveProperty("author", "alice");
    expect(msg).toHaveProperty("text");
    expect(msg).toHaveProperty("likes");
    expect(msg).toHaveProperty("isPinned", true);
    expect(msg.likes).toBeGreaterThanOrEqual(5);
  }

  // Test with higher minLikes threshold
  const veryPopularMessages = await responseClient.query(
    anyApi.public.getPopularPinnedMessages,
    {
      author: "alice",
      minLikes: 12,
    },
  );
  expect(veryPopularMessages).toHaveLength(1);
  expect(veryPopularMessages[0].text).toBe("Very popular pinned");

  // Test with low minLikes threshold
  const allPinnedMessages = await responseClient.query(
    anyApi.public.getPopularPinnedMessages,
    {
      author: "alice",
      minLikes: 0,
    },
  );
  expect(allPinnedMessages).toHaveLength(3);
  expect(allPinnedMessages[0].text).toBe("Very popular pinned");
  expect(allPinnedMessages[1].text).toBe("Popular pinned");
  expect(allPinnedMessages[2].text).toBe("Unpopular pinned");
});
