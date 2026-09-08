import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [projectDir, workspaceId] = process.argv.slice(2);
const bounds = [];
const streams = new Map();
const issuedIds = new Set();
const violations = [];
let nextId = 0;

function requireBound(value) {
  const valid = Number.isSafeInteger(value) && value > 0;
  if (!valid)
    violations.push("The consumed query needs a positive finite bound");
  assert(valid, "The consumed query needs a positive finite bound");
  bounds.push(value);
}

function rows(limit) {
  // These rows only establish that the handler returns the bounded read's
  // output. This probe does not simulate filtering or index semantics;
  // the real-backend tests verify those and the actual document contents.
  return Array.from({ length: Math.min(limit, 3) }, () => {
    const id = `probe-${nextId++}`;
    issuedIds.add(id);
    return {
      _id: id,
      _creationTime: nextId,
      workspaceId,
      actor: `actor-${nextId}`,
      action: `action-${nextId}`,
    };
  });
}

async function invoke(name, args) {
  const [moduleName, exportName = "default"] = name.split(":");
  const module = await import(
    pathToFileURL(join(projectDir, "convex", `${moduleName}.ts`)).href
  );
  assert.equal(
    typeof module[exportName]?.invokeQuery,
    "function",
    `Missing query ${name}`,
  );
  return JSON.parse(
    await module[exportName].invokeQuery(JSON.stringify([args])),
  );
}

// Use the generated project's real Convex SDK and query builder. Inspect the
// serialized query only when the handler consumes it, so constants, aliases,
// imported helpers, and unrelated exports do not confuse the check. In the SDK,
// take(n) adds a native limit operator before collecting the bounded stream.
globalThis.Convex = {
  syscall(op, jsonArgs) {
    const args = JSON.parse(jsonArgs);
    if (op === "1.0/queryStream") {
      const limits = args.query.operators
        .filter((operator) => "limit" in operator)
        .map((operator) => operator.limit);
      requireBound(limits.length ? Math.min(...limits) : undefined);
      const queryId = nextId++;
      streams.set(queryId, rows(Math.min(...limits)));
      return JSON.stringify({ queryId });
    }
    if (op === "1.0/queryCleanup") {
      streams.delete(args.queryId);
      return "null";
    }
    throw new Error(`Unsupported query probe syscall: ${op}`);
  },
  async asyncSyscall(op, jsonArgs) {
    const args = JSON.parse(jsonArgs);
    if (op === "1.0/queryStreamNext") {
      const remaining = streams.get(args.queryId);
      assert(remaining, "Unknown query stream");
      const value = remaining.shift();
      return JSON.stringify({
        value: value ?? null,
        done: value === undefined,
      });
    }
    if (op === "1.0/queryPage") {
      requireBound(args.pageSize);
      return JSON.stringify({
        page: rows(args.pageSize),
        // Never signal exhaustion: collecting every page is still unbounded.
        isDone: false,
        continueCursor: `cursor-${nextId++}`,
      });
    }
    if (op === "1.0/runUdf" && args.udfType === "query") {
      return JSON.stringify(await invoke(args.name, args.args));
    }
    throw new Error(`Unsupported query probe syscall: ${op}`);
  },
};

const result = await invoke("index:listAuditLogs", { workspaceId });
assert.deepEqual(
  violations,
  [],
  "An unbounded read was attempted, even if its error was caught",
);
assert(bounds.length > 0, "No bounded database query was consumed");
assert(
  Array.isArray(result) && result.length > 0,
  "Return entries from the bounded read",
);
assert(
  result.every((row) => issuedIds.has(row?._id)),
  "Return entries from the bounded read",
);
console.log(`BOUNDED_QUERY:${JSON.stringify({ bounds })}`);
