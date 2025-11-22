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

test("get post comments returns empty array when no comments exist", async () => {
  const comments = await responseClient.query(anyApi.public.getPostComments, {
    postId: "post1",
  });
  expect(comments).toEqual([]);
});

test("get post comments returns correctly filtered and sorted comments", async () => {
  const testComments = [
    { postId: "post1", author: "alice", text: "First comment" },
    { postId: "post1", author: "bob", text: "Second comment" },
    { postId: "post1", author: "charlie", text: "Third comment" },
    { postId: "post1", author: "david", text: "Fourth comment" },
    { postId: "post2", author: "alice", text: "Other post comment" },
  ];

  for (const comment of testComments) {
    await addDocuments(responseAdminClient, "comments", [comment]);
  }

  // Test basic filtering and sorting
  const comments = await responseClient.query(anyApi.public.getPostComments, {
    postId: "post1",
  });

  // Should return all comments for post1
  expect(comments).toHaveLength(4);

  // Should be sorted by creation time descending
  for (let i = 0; i < comments.length - 1; i++) {
    expect(comments[i]._creationTime).toBeGreaterThan(
      comments[i + 1]._creationTime,
    );
  }

  // Verify all fields are present and correct
  for (const comment of comments) {
    expect(comment).toHaveProperty("_id");
    expect(comment).toHaveProperty("_creationTime");
    expect(comment).toHaveProperty("postId", "post1");
    expect(comment).toHaveProperty("author");
    expect(comment).toHaveProperty("text");
  }

  // Verify order matches insertion order (reversed due to descending sort)
  expect(comments[3].text).toBe("First comment");
  expect(comments[2].text).toBe("Second comment");
  expect(comments[1].text).toBe("Third comment");
  expect(comments[0].text).toBe("Fourth comment");

  // Test different post
  const otherPostComments = await responseClient.query(
    anyApi.public.getPostComments,
    {
      postId: "post2",
    },
  );
  expect(otherPostComments).toHaveLength(1);
  expect(otherPostComments[0].text).toBe("Other post comment");
});
