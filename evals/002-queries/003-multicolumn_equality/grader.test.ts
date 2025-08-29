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

test("get project tasks by status returns empty array when no tasks exist", async () => {
  const tasks = await responseClient.query(
    anyApi.public.getProjectTasksByStatus,
    {
      projectId: "project1",
      status: "todo",
    },
  );
  expect(tasks).toEqual([]);
});

test("get project tasks by status returns correctly filtered and sorted tasks", async () => {
  // Load test data with mix of projects, statuses, and priorities
  const testTasks = [
    {
      projectId: "project1",
      status: "todo",
      priority: 1,
      title: "Task 1",
      assignee: "alice",
    },
    {
      projectId: "project1",
      status: "todo",
      priority: 2,
      title: "Task 2",
      assignee: "bob",
    },
    {
      projectId: "project1",
      status: "todo",
      priority: 3,
      title: "Task 3",
      assignee: "charlie",
    },
    {
      projectId: "project1",
      status: "todo",
      priority: 4,
      title: "Task 4",
      assignee: "david",
    },
    {
      projectId: "project1",
      status: "todo",
      priority: 5,
      title: "Task 5",
      assignee: "eve",
    },
    {
      projectId: "project1",
      status: "todo",
      priority: 6,
      title: "Task 6",
      assignee: "frank",
    },
    {
      projectId: "project1",
      status: "done",
      priority: 1,
      title: "Done Task",
      assignee: "alice",
    },
    {
      projectId: "project2",
      status: "todo",
      priority: 1,
      title: "Other Project",
      assignee: "alice",
    },
  ];
  await addDocuments(responseAdminClient, "tasks", testTasks);

  // Test basic filtering and sorting
  const todoTasks = await responseClient.query(
    anyApi.public.getProjectTasksByStatus,
    {
      projectId: "project1",
      status: "todo",
    },
  );

  // Should return at most 5 tasks
  expect(todoTasks).toHaveLength(5);

  // Should be sorted by priority ascending
  for (let i = 0; i < todoTasks.length - 1; i++) {
    expect(todoTasks[i].priority).toBeLessThan(todoTasks[i + 1].priority);
  }

  // Verify all fields are present and correct
  for (const task of todoTasks) {
    expect(task).toHaveProperty("_id");
    expect(task).toHaveProperty("_creationTime");
    expect(task).toHaveProperty("projectId", "project1");
    expect(task).toHaveProperty("status", "todo");
    expect(task).toHaveProperty("priority");
    expect(task).toHaveProperty("title");
    expect(task).toHaveProperty("assignee");
  }

  // Test different status
  const doneTasks = await responseClient.query(
    anyApi.public.getProjectTasksByStatus,
    {
      projectId: "project1",
      status: "done",
    },
  );
  expect(doneTasks).toHaveLength(1);
  expect(doneTasks[0].title).toBe("Done Task");

  // Test different project
  const otherProjectTasks = await responseClient.query(
    anyApi.public.getProjectTasksByStatus,
    {
      projectId: "project2",
      status: "todo",
    },
  );
  expect(otherProjectTasks).toHaveLength(1);
  expect(otherProjectTasks[0].title).toBe("Other Project");
});
