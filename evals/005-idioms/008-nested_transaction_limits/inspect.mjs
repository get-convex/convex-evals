import {
  candidateProbeFailure,
  unsupportedProbe,
} from "../../../grader/probeErrors.mjs";

export async function inspect(
  modules,
  { job },
  { jsonToConvex, convexToJson },
) {
  if (!modules.index)
    candidateProbeFailure("Missing required module convex/index.ts");
  const nativeConvex = globalThis.Convex;
  const functionNames = new Map();
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function invoke(name, args, udfType = "mutation") {
    const [moduleName, exportName = "default"] = name.split(":");
    const module = await modules[moduleName]();
    const method = udfType === "mutation" ? "invokeMutation" : "invokeQuery";
    assert(
      typeof module[exportName]?.[method] === "function",
      `Missing ${udfType} ${name}`,
    );
    return jsonToConvex(
      JSON.parse(await module[exportName][method](JSON.stringify([args]))),
    );
  }

  let calls = 0;
  // Exercise both sides of the boundary using the deployed test inputs. This checks
  // representative execution paths, not every possible input or branch.
  for (const count of [2, 4, 5, 6, 10]) {
    let currentJob = { ...job };
    const streams = new Map();
    let nextStream = 0;
    const unsupported = [];
    let observeCall;
    const childCall = new Promise((resolve) => {
      observeCall = resolve;
    });

    function unsupportedOperation(op) {
      const message = `Unsupported nested-limit probe syscall: ${op}`;
      unsupported.push(message);
      unsupportedProbe(message);
    }

    // Only one pending job and no deliveries exist in this scenario. Permit
    // reads of that state before the child call; query style is not graded here.
    function evaluate(expression, doc) {
      if ("$literal" in expression) {
        const value = expression.$literal;
        return value && typeof value === "object" && "$undefined" in value
          ? undefined
          : value;
      }
      if ("$field" in expression)
        return expression.$field
          .split(".")
          .reduce((value, key) => value?.[key], doc);
      const [op, operands] = Object.entries(expression)[0];
      if (op === "$not") return !evaluate(operands, doc);
      if (op === "$neg") return -evaluate(operands, doc);
      const values = operands.map((operand) => evaluate(operand, doc));
      const [a, b] = values;
      switch (op) {
        case "$eq":
          return a === b;
        case "$neq":
          return a !== b;
        case "$lt":
          return a < b;
        case "$lte":
          return a <= b;
        case "$gt":
          return a > b;
        case "$gte":
          return a >= b;
        case "$and":
          return values.every(Boolean);
        case "$or":
          return values.some(Boolean);
        case "$add":
          return a + b;
        case "$sub":
          return a - b;
        case "$mul":
          return a * b;
        case "$div":
          return a / b;
        case "$mod":
          return a % b;
        default:
          return unsupportedOperation(`filter ${op}`);
      }
    }

    function queryRows({ source, operators }) {
      const table = source.tableName ?? source.indexName.split(".")[0];
      if (
        !["jobs", "deliveries"].includes(table) ||
        !["FullTableScan", "IndexRange"].includes(source.type)
      )
        return unsupportedOperation("query source");
      let rows = table === "jobs" ? [currentJob] : [];
      for (const bound of source.range ?? []) {
        const expression = {
          [`$${bound.type.toLowerCase()}`]: [
            { $field: bound.fieldPath },
            { $literal: bound.value },
          ],
        };
        rows = rows.filter((doc) => evaluate(expression, doc));
      }
      for (const operator of operators) {
        if ("filter" in operator)
          rows = rows.filter((doc) => evaluate(operator.filter, doc));
        else if ("limit" in operator) rows = rows.slice(0, operator.limit);
        else return unsupportedOperation("query operator");
      }
      return rows;
    }

    globalThis.Convex = {
      ...nativeConvex,
      syscall(op, jsonArgs) {
        const args = JSON.parse(jsonArgs);
        if (op === "1.0/queryStream") {
          const queryId = nextStream++;
          streams.set(queryId, queryRows(args.query));
          return JSON.stringify({ queryId });
        }
        if (op === "1.0/queryCleanup") {
          streams.delete(args.queryId);
          return "null";
        }
        if (op === "1.0/db/normalizeId")
          return JSON.stringify({
            id:
              args.table === "jobs" && args.idString === job._id
                ? job._id
                : null,
          });
        return unsupportedOperation(op);
      },
      async asyncSyscall(op, jsonArgs) {
        const args = JSON.parse(jsonArgs);
        if (op === "1.0/createFunctionHandle") {
          // Let Convex produce its own opaque handle. Remember the explicit
          // SDK address instead of deriving a module name from handle text.
          if (!args.name || !nativeConvex?.asyncSyscall)
            return unsupportedOperation("function handle target");
          const result = await nativeConvex.asyncSyscall(op, jsonArgs);
          functionNames.set(JSON.parse(result), args.name);
          return result;
        }
        if (op === "1.0/queryStreamNext") {
          const value = streams.get(args.queryId)?.shift();
          return JSON.stringify({
            value: value ?? null,
            done: value === undefined,
          });
        }
        if (op === "1.0/queryPage") {
          const rows = queryRows(args.query);
          const offset = Number(args.cursor ?? 0);
          return JSON.stringify({
            page: rows.slice(offset, offset + args.pageSize),
            isDone: offset + args.pageSize >= rows.length,
            continueCursor: String(offset + args.pageSize),
          });
        }
        if (op === "1.0/runUdf") {
          const name = args.name ?? functionNames.get(args.functionHandle);
          if (!name) return unsupportedOperation("nested function address");
          if (args.udfType === "mutation" && name === "index:writeDeliveries") {
            // These are the serialized options consumed by the real Convex SDK,
            // after aliases, computed properties and imported helpers execute.
            observeCall(args);
            // Suspend at the child boundary. Do not fabricate a child result or
            // a limit error, or simulate rollback. The deployed tests own those
            // assertions, including direct child calls and parent persistence.
            return await new Promise(() => {});
          }
          if (["mutation", "query"].includes(args.udfType))
            return JSON.stringify(
              convexToJson(await invoke(name, args.args, args.udfType)),
            );
        }
        // Allow ordinary job checks/updates before the nested call, including
        // legacy and table-scoped SDK signatures. No delivery writes run here.
        const isJob =
          !args.isSystem &&
          (args.table === undefined || args.table === "jobs") &&
          args.id === job._id;
        if (op === "1.0/get") return JSON.stringify(isJob ? currentJob : null);
        if (isJob && op === "1.0/shallowMerge") {
          currentJob = { ...currentJob, ...args.value };
          return "null";
        }
        if (isJob && op === "1.0/replace") {
          currentJob = {
            ...args.value,
            _id: job._id,
            _creationTime: job._creationTime,
          };
          return "null";
        }
        return unsupportedOperation(op);
      },
    };

    const observed = await Promise.race([
      childCall,
      invoke("index:processFanout", { jobId: job._id, count }).then(() => {
        throw new Error(`No nested writeDeliveries call for count ${count}`);
      }),
    ]);
    assert(unsupported.length === 0, unsupported.join("; "));
    assert(
      observed.args.jobId === job._id && observed.args.count === count,
      `Pass the original jobId and count to writeDeliveries for count ${count}`,
    );
    assert(
      observed.transactionLimits?.documentsWritten === 5,
      `The executed writeDeliveries call needs a native five-write limit for count ${count}`,
    );
    calls++;
  }
  return { calls };
}
