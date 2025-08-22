import { expect, test } from "vitest";
import {
  responseAdminClient,
  addDocuments,
  listTable,
  hasIndexOn,
  hasIndexWithPrefix,
} from "../../../grader";

test("organization data model works correctly", async () => {
  // Create organization
  await addDocuments(responseAdminClient, "organizations", [
    {
      name: "Acme, Inc.",
    },
  ]);
  const organizations = (await listTable(
    responseAdminClient,
    "organizations",
  )) as { _id: string; name: string }[];
  const orgId = (organizations.at(-1) as { _id: string })._id;
  expect(orgId).toBeDefined();

  // Create department
  await addDocuments(responseAdminClient, "departments", [
    {
      name: "Marketing",
      organizationId: orgId,
    },
  ]);
  const departments = (await listTable(responseAdminClient, "departments")) as {
    _id: string;
    name: string;
    organizationId: string;
  }[];
  const deptId = (departments.at(-1) as { _id: string })._id;
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
  const employees = (await listTable(responseAdminClient, "employees")) as {
    _id: string;
    name: string;
    organizationId: string;
    departmentId: string;
    email: string;
  }[];
  const janeId = (employees.at(-1) as { _id: string })._id;
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

test("schema has indexes for departments by organization and employees by email, department, organization", async () => {
  const deptByOrg = await hasIndexOn(responseAdminClient, "departments", [
    "organizationId",
  ]);
  const empByEmail = await hasIndexOn(responseAdminClient, "employees", [
    "email",
  ]);
  const empByDept = await hasIndexOn(responseAdminClient, "employees", [
    "departmentId",
  ]);
  const empByOrg = await hasIndexOn(responseAdminClient, "employees", [
    "organizationId",
  ]);
  expect(deptByOrg).toBe(true);
  expect(empByEmail).toBe(true);
  expect(empByDept).toBe(true);
  expect(empByOrg).toBe(true);
});
