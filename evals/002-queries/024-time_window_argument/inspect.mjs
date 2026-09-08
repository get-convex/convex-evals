export async function inspect(modules, { timeArgName, now }) {
  const violations = [];
  const streams = new Map();
  const issuedDocs = new Map();
  let reads = 0;
  let sampleSize = 0;

  function assert(condition, message) {
    if (!condition) {
      violations.push(message);
      throw new Error(message);
    }
  }

  // Install before loading model modules so captured/module-level clock reads
  // and imported helpers are covered too. Uninvoked mutations never run here.
  const NativeDate = Date;
  // Replace the method itself so its descriptor cannot expose an untrapped
  // now(). Keep parse(), UTC(), and dated construction intact.
  NativeDate.now = () =>
    assert(false, "Query read the wall clock with Date.now()");
  globalThis.Date = new Proxy(NativeDate, {
    apply() {
      assert(false, "Query read the wall clock with Date()");
    },
    construct(target, args, newTarget) {
      assert(args.length > 0, "Query read the wall clock with new Date()");
      return Reflect.construct(target, args, newTarget);
    },
  });
  // Date.prototype and Date instances must lead back to the trapped constructor.
  NativeDate.prototype.constructor = globalThis.Date;

  async function invoke(name, args) {
    const [moduleName, exportName = "default"] = name.split(":");
    const module = await modules[moduleName]();
    assert(
      typeof module[exportName]?.invokeQuery === "function",
      `Missing query ${name}`,
    );
    return JSON.parse(
      await module[exportName].invokeQuery(JSON.stringify([args])),
    );
  }

  globalThis.Convex = {
    syscall(op, jsonArgs) {
      const args = JSON.parse(jsonArgs);
      if (op === "1.0/queryStream") {
        const { source, operators } = args.query;
        assert(
          source.type === "IndexRange" &&
            source.indexName === "items.by_expiresAt",
          "Consume the items expiration index",
        );
        assert(
          source.range.some(
            (bound) =>
              bound.fieldPath === "expiresAt" &&
              bound.type === "Gt" &&
              bound.value === now,
          ),
          "Use the caller's timestamp as the strict index lower bound",
        );
        assert(
          source.order === null || source.order === "asc",
          "Read the soonest-expiring items first",
        );
        assert(
          operators.every((operator) => "limit" in operator) &&
            operators.some(
              ({ limit }) =>
                Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
            ),
          "Consume a native bounded read without a database filter",
        );
        const queryId = reads++;
        const limit = Math.min(...operators.map(({ limit }) => limit));
        // The deployed tests verify real documents and ordering. Synthetic IDs
        // establish that this bounded read actually supplies the returned rows.
        const rows = Array.from(
          { length: Math.min(limit, sampleSize) },
          (_, i) => {
            const _id = `probe-${queryId}-${i}`;
            const row = {
              _id,
              _creationTime: i,
              name: _id,
              expiresAt: now + i + 1,
            };
            issuedDocs.set(_id, row);
            return row;
          },
        );
        streams.set(queryId, rows);
        return JSON.stringify({ queryId });
      }
      if (op === "1.0/queryCleanup") {
        streams.delete(args.queryId);
        return "null";
      }
      assert(false, `Unsupported query probe syscall: ${op}`);
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
      // A point read can re-fetch a row already supplied by the bounded index
      // read. It does not establish or substitute for that indexed read.
      if (op === "1.0/get")
        return JSON.stringify(
          !args.isSystem && (args.table === undefined || args.table === "items")
            ? (issuedDocs.get(args.id) ?? null)
            : null,
        );
      if (op === "1.0/runUdf" && args.udfType === "query")
        return JSON.stringify(await invoke(args.name, args.args));
      assert(false, `Unsupported query probe syscall: ${op}`);
    },
  };

  // Exercise empty, partial, and full result branches at different cutoffs.
  // This is a runtime check over representative paths, not a proof about every
  // possible branch. The deployed tests independently verify actual data.
  for (const [cutoff, size] of [
    [now, 0],
    [now + 1500, 3],
    [now - 6000, 100],
  ]) {
    now = cutoff;
    sampleSize = size;
    streams.clear();
    issuedDocs.clear();
    const previousReads = reads;
    const result = await invoke("index:listActive", { [timeArgName]: now });
    assert(violations.length === 0, "Query caught a prohibited read's error");
    assert(reads > previousReads, "No indexed bounded read was consumed");
    assert(
      Array.isArray(result) &&
        (size === 0 ? result.length === 0 : result.length > 0) &&
        result.every((row) => issuedDocs.has(row?._id)),
      "Return the documents from the indexed bounded read",
    );
  }
  return { reads };
}
