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
  process.stdout.write(JSON.stringify({ result: context.dump(state.value) }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: `Query probe failed: ${String(error)}` }),
  );
}

// Exiting the child discards the entire WASM instance without individual handle
// cleanup. This also handles memory exhaustion: QuickJS can fail
// during individual handle cleanup after an OOM in a nested async function.
