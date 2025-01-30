import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  addDocuments,
  listTable,
} from "../../../grader";
import {  } from "convex/values";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("organization data model works correctly", async () => {
  // Create organization
  await addDocuments(responseAdminClient, "organizations", [
    {
      name: "Acme, Inc.",
    },
  ]);
  const organizations = await listTable(responseAdminClient, "organizations");
  const orgId = (organizations.at(-1) as Doc<"organizations">)._id;
  expect(orgId).toBeDefined();

  // Create department
  await addDocuments(responseAdminClient, "departments", [
    {
      name: "Marketing",
      organizationId: orgId,
    },
  ]);
  const departments = await listTable(responseAdminClient, "departments");
  const deptId = (departments.at(-1) as Doc<"departments">)._id;
  expect(deptId).toBeDefined();

  // Create employees
  await addDocuments(responseAdminClient, "employees", [
    {
      name: "Jane",
      departmentId: deptId,
      organizationId: orgId,
      email: "jane@example.com",
      phone: "0987654321",
      age: 25,
    },
  ]);
  const employees = await listTable(responseAdminClient, "employees");
  const janeId = (employees.at(-1) as Doc<"employees">)._id;
  expect(janeId).toBeDefined();

  // Update department with manager
  await addDocuments(responseAdminClient, "departments", [
    {
      name: "Engineering",
      organizationId: orgId,
      managerId: janeId,
    },
  ]);
});
