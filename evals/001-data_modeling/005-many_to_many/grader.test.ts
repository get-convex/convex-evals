import { expect, test } from "vitest";
import {
  responseAdminClient,
  addDocuments,
  listTable,
  getSchema,
  hasIndexWithPrefix,
} from "../../../grader";

// Basic sanity: can insert students and courses, and an enrollment row that references both with metadata

test("students, courses, and enrollments accept required fields", async () => {
  await addDocuments(responseAdminClient, "students", [
    { name: "Alice", email: "a@example.com" },
  ]);
  const students = await listTable(responseAdminClient, "students");
  const studentId = (students.at(-1) as { _id: string })._id;

  await addDocuments(responseAdminClient, "courses", [
    { name: "CS101", code: "CS101", description: "Intro" },
  ]);
  const courses = await listTable(responseAdminClient, "courses");
  const courseId = (courses.at(-1) as { _id: string })._id;

  await addDocuments(responseAdminClient, "enrollments", [
    { studentId, courseId, enrollmentDate: Date.now(), grade: "A" },
  ]);
  const enrollments = await listTable(responseAdminClient, "enrollments");
  expect(enrollments.length).toBeGreaterThan(0);
});

test("schema has indexes to support enrollments by student and by course", async () => {
  const schema = await getSchema(responseAdminClient);
  const byStudent = await hasIndexWithPrefix(schema, "enrollments", [
    "studentId",
  ]);
  const byCourse = await hasIndexWithPrefix(schema, "enrollments", [
    "courseId",
  ]);
  expect(byStudent).toBe(true);
  expect(byCourse).toBe(true);
});
