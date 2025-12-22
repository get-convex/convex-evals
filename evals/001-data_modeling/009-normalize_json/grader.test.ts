import { expect, test } from "vitest";
import {
  responseAdminClient,
  addDocuments,
  listTable,
  hasIndexOn,
  hasIndexWithPrefix,
  getSchema,
} from "../../../grader";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("organization data model works correctly", async () => {
  const schema = (await getSchema(
    responseAdminClient as unknown as object,
  )) as { tables?: { tableName: string }[] } | null;
  const tables: string[] = (schema?.tables ?? []).map((t) => t.tableName);
  const deptTable = tables.includes("departments")
    ? "departments"
    : tables.includes("department")
      ? "department"
      : "departments";
  const orgTable = tables.includes("organizations")
    ? "organizations"
    : tables.includes("organization")
      ? "organization"
      : "organizations";
  const empTable = tables.includes("employees")
    ? "employees"
    : tables.includes("employee")
      ? "employee"
      : "employees";

  // Create organization
  await addDocuments(responseAdminClient, orgTable, [
    {
      name: "Acme, Inc.",
    },
  ]);
  const organizations = (await listTable(responseAdminClient, orgTable)) as {
    _id: string;
    name: string;
  }[];
  const orgId = (organizations.at(-1) as { _id: string })._id;
  expect(orgId).toBeDefined();

  // Create department
  await addDocuments(responseAdminClient, deptTable, [
    {
      name: "Marketing",
      organizationId: orgId,
    },
  ]);
  const departments = (await listTable(responseAdminClient, deptTable)) as {
    _id: string;
    name: string;
    organizationId: string;
  }[];
  const deptId = (departments.at(-1) as { _id: string })._id;
  expect(deptId).toBeDefined();

  // Create employees
  await addDocuments(responseAdminClient, empTable, [
    {
      name: "Jane",
      departmentId: deptId,
      organizationId: orgId,
      email: "jane@example.com",
      phone: "0987654321",
      age: 25,
    },
  ]);
  const employees = (await listTable(responseAdminClient, empTable)) as {
    _id: string;
    name: string;
    organizationId: string;
    departmentId: string;
    email: string;
  }[];
  const janeId = (employees.at(-1) as { _id: string })._id;
  expect(janeId).toBeDefined();

  // Update department with manager (handle either managerId or manager string)
  try {
    await addDocuments(responseAdminClient, deptTable, [
      {
        name: "Engineering",
        organizationId: orgId,
        managerId: janeId as unknown as string,
      },
    ]);
  } catch (_e) {
    await addDocuments(responseAdminClient, deptTable, [
      {
        name: "Engineering",
        organizationId: orgId,
        manager: "Jane",
      },
    ]);
  }
});

test("schema has indexes for departments by organization and employees by email, department, organization", async () => {
  const schema = (await getSchema(
    responseAdminClient as unknown as object,
  )) as { tables?: { tableName: string }[] } | null;
  const tables: string[] = (schema?.tables ?? []).map((t) => t.tableName);
  const deptTable = tables.includes("departments")
    ? "departments"
    : tables.includes("department")
      ? "department"
      : "departments";
  const empTable = tables.includes("employees")
    ? "employees"
    : tables.includes("employee")
      ? "employee"
      : "employees";

  const deptByOrg = await hasIndexWithPrefix(schema, deptTable, [
    "organizationId",
  ]);
  const empByEmail = await hasIndexWithPrefix(schema, empTable, ["email"]);
  const empByDept = await hasIndexWithPrefix(schema, empTable, [
    "departmentId",
  ]);
  const empByOrg = await hasIndexWithPrefix(schema, empTable, [
    "organizationId",
  ]);
  expect(deptByOrg).toBe(true);
  expect(empByEmail).toBe(true);
  expect(empByDept).toBe(true);
  expect(empByOrg).toBe(true);
});
