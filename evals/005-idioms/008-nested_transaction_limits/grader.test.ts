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
import { anyApi } from "convex/server";
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
  // Return validators are not required by the task, so ignore them.
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("writeDeliveries itself is not limited when called directly", async () => {
  // The 5-document gate must come from the parent's transactionLimits, not
  // from the child checking its own count.
  const jobId = await seedJob("job-direct-child");
  await responseAdminClient.mutation(anyApi.index.writeDeliveries as any, {
    jobId,
    count: 6,
  });
  expect(await getDeliveries(jobId)).toHaveLength(6);
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

function hasRunMutationWithDocumentsWrittenLimit(
  sourceText: string,
  expectedLimit: number,
): boolean {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Resolve identifiers through `const X = ...` declarations anywhere in the
  // file (including inside handlers) so that answers which factor the options
  // or limits into a named constant still pass.
  const constDeclarations = new Map<string, ts.Expression>();
  const collectDeclarations = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      constDeclarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  const resolve = (expr: ts.Expression): ts.Expression => {
    let current = expr;
    for (let i = 0; i < 5; i++) {
      if (ts.isIdentifier(current) && constDeclarations.has(current.text)) {
        current = constDeclarations.get(current.text)!;
      } else if (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
        current = current.expression;
      } else {
        break;
      }
    }
    return current;
  };
  const getProperty = (
    obj: ts.Expression,
    name: string,
  ): ts.Expression | undefined => {
    const resolved = resolve(obj);
    if (!ts.isObjectLiteralExpression(resolved)) return undefined;
    for (const p of resolved.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === name
      ) {
        return p.initializer;
      }
    }
    return undefined;
  };

  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "runMutation" &&
      node.arguments.length >= 3
    ) {
      const limits = getProperty(node.arguments[2], "transactionLimits");
      if (limits !== undefined) {
        const documentsWritten = getProperty(limits, "documentsWritten");
        if (documentsWritten !== undefined) {
          const value = resolve(documentsWritten);
          if (
            ts.isNumericLiteral(value) &&
            Number(value.text) === expectedLimit
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

test("generated solution limits the nested runMutation to 5 documents written", () => {
  const sourceText = readOutputFile(
    "005-idioms",
    "008-nested_transaction_limits",
    "convex/index.ts",
  );
  expect(hasRunMutationWithDocumentsWrittenLimit(sourceText, 5)).toBe(true);
});
