import {
  newQuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";

try {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  const quickjs = await newQuickJSWASMModule();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 2_000));
  const context = runtime.newContext();
  const promise = context.unwrapResult(
    context.evalCode(
      `globalThis.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };\n${source}\nprobeBundle.default;`,
    ),
  );
  const jobs = runtime.executePendingJobs();
  if (jobs.error) throw new Error(JSON.stringify(context.dump(jobs.error)));
  const state = context.getPromiseState(promise);
  if (state.type === "rejected")
    throw new Error(JSON.stringify(context.dump(state.error)));
  if (state.type !== "fulfilled") throw new Error("Probe did not finish");
  // QuickJS dump already converts objects to JSON-compatible values. Its scalar
  // results also include bigint, undefined, NaN, infinities, and negative zero;
  // tag those types so the process transport preserves the former worker result.
  const value = context.dump(state.value);
  let result;
  if (typeof value === "bigint")
    result = { kind: "bigint", value: String(value) };
  else if (typeof value === "number")
    result = {
      kind: "number",
      value: Object.is(value, -0) ? "-0" : String(value),
    };
  else if (value === undefined) result = { kind: "undefined" };
  else if (typeof value === "symbol")
    throw new Error("Query probe symbols cannot be cloned");
  else result = { kind: "json", value };
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: `Query probe failed: ${String(error)}` }),
  );
}

// Exiting the child discards the entire WASM instance without individual handle
// cleanup. This also handles memory exhaustion: QuickJS can fail
// during individual handle cleanup after an OOM in a nested async function.
