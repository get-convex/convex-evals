import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";
import ts from "typescript";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["deliveries", "jobs"]);
});

async function seedJob(name: string): Promise<Id<"jobs">> {
  await addDocuments(responseAdminClient, "jobs", [
    { name, status: "pending" },
  ]);
  const jobs = (await listTable(responseAdminClient, "jobs")) as Doc<"jobs">[];
  return jobs.find((j) => j.name === name)!._id;
}

async function getJob(jobId: Id<"jobs">): Promise<Doc<"jobs">> {
  const jobs = (await listTable(responseAdminClient, "jobs")) as Doc<"jobs">[];
  return jobs.find((j) => j._id === jobId)!;
}

async function getDeliveries(jobId: Id<"jobs">): Promise<Doc<"deliveries">[]> {
  const deliveries = (await listTable(
    responseAdminClient,
    "deliveries",
  )) as Doc<"deliveries">[];
  return deliveries.filter((d) => d.jobId === jobId);
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("fanout at the limit succeeds and completes the job", async () => {
  const jobId = await seedJob("job-at-limit");

  const result = await responseClient.mutation(api.index.processFanout, {
    jobId,
    count: 5,
  });

  expect(result).toBe("completed");
  expect((await getJob(jobId)).status).toBe("completed");

  const deliveries = await getDeliveries(jobId);
  expect(deliveries).toHaveLength(5);
  expect(new Set(deliveries.map((d) => d.recipient))).toEqual(
    new Set(["recipient-0", "recipient-1", "recipient-2", "recipient-3", "recipient-4"]),
  );
});

test("small fanout succeeds", async () => {
  const jobId = await seedJob("job-small");

  const result = await responseClient.mutation(api.index.processFanout, {
    jobId,
    count: 2,
  });

  expect(result).toBe("completed");
  expect((await getJob(jobId)).status).toBe("completed");
  expect(await getDeliveries(jobId)).toHaveLength(2);
});

test("overflow rolls back deliveries but commits the rejection", async () => {
  const jobId = await seedJob("job-overflow");

  const result = await responseClient.mutation(api.index.processFanout, {
    jobId,
    count: 6,
  });

  expect(result).toBe("rejected");
  expect((await getJob(jobId)).status).toBe("rejected");
  // No partial writes: the first five inserts must have rolled back too.
  expect(await getDeliveries(jobId)).toHaveLength(0);
});

test("jobs do not contaminate one another", async () => {
  const goodJobId = await seedJob("job-good");
  const badJobId = await seedJob("job-bad");

  const goodResult = await responseClient.mutation(api.index.processFanout, {
    jobId: goodJobId,
    count: 4,
  });
  const badResult = await responseClient.mutation(api.index.processFanout, {
    jobId: badJobId,
    count: 10,
  });

  expect(goodResult).toBe("completed");
  expect(badResult).toBe("rejected");
  expect((await getJob(goodJobId)).status).toBe("completed");
  expect((await getJob(badJobId)).status).toBe("rejected");
  expect(await getDeliveries(goodJobId)).toHaveLength(4);
  expect(await getDeliveries(badJobId)).toHaveLength(0);
});

function hasRunMutationWithTransactionLimits(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "runMutation" &&
      node.arguments.length >= 3
    ) {
      const options = node.arguments[2];
      if (
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (p) =>
            p.name !== undefined &&
            ts.isIdentifier(p.name) &&
            p.name.text === "transactionLimits",
        )
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

test("generated solution passes transactionLimits to the nested runMutation", () => {
  const sourceText = readOutputFile(
    "005-idioms",
    "008-nested_transaction_limits",
    "convex/index.ts",
  );
  expect(hasRunMutationWithTransactionLimits(sourceText)).toBe(true);
});
