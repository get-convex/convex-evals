// Portable, deliberately bounded adapters for selected recorded questions. Historical
// author scripts in evidence.jsonl.gz are archival source, not executable entrypoints.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repository, readArchive, requireArtifact, sha256, manifest } from "./archive.mjs";

const args = process.argv.slice(2);
const mode = args.shift();
const flags = new Map();
while (args.length) {
  const flag = args.shift(), value = args.shift();
  if (!["--backend", "--npm", "--output"].includes(flag) || !value) throw new Error("Invalid replay arguments");
  flags.set(flag, value);
}
if (!["staged-index", "visibility", "document-validator", "nested-limits", "agent-attribution"].includes(mode)) throw new Error("Usage: node verification/decisions/replay.mjs staged-index | visibility | document-validator | nested-limits | agent-attribution --backend <binary> [--npm <executable>] [--output <json>]");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required");
if (mode !== "staged-index" && !flags.has("--backend")) throw new Error("This replay requires an explicit local backend binary; see docs/decision-verification.md");
const artifacts = await readArchive();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "decision-replay-"));
const redactions = [temporary];
const clean = (value) => redactions.reduce((text, value) => text.split(value).join("<temporary-or-local-credential>"), String(value));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
  CI: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", CONVEX_DISABLE_ANALYTICS: "1",
  DISABLE_BEACON: "1", DISABLE_CONVEX_REPORTING: "1", CONVEX_OVERRIDE_ACCESS_TOKEN: "unused-local-replay",
  npm_config_userconfig: path.join(temporary, ".npmrc"), npm_config_cache: path.join(temporary, "npm-cache"),
};
await fs.writeFile(env.npm_config_userconfig, "");
let backend;
const report = { mode, node: process.version, question: null, observations: [], limitations: [] };

function command(executable, argv, cwd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (value) => stdout += value);
    child.stderr.on("data", (value) => stderr += value);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

async function install(directory, sdk) {
  await fs.mkdir(directory, { recursive: true });
  const pinned = path.join(repository, "verification/decisions/dependencies", sdk);
  for (const name of ["package.json", "package-lock.json"]) await fs.copyFile(path.join(pinned, name), path.join(directory, name));
  // Skip package lifecycle scripts. Convex's platform-specific esbuild package
  // is installed by npm as an optional dependency and needs no postinstall here.
  const result = await command(flags.get("--npm") ?? "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], directory);
  if (result.code !== 0) throw new Error(`Dependency installation failed: ${clean(result.stderr)}`);
  const declared = JSON.parse(await fs.readFile(path.join(pinned, "package.json"), "utf8")).dependencies;
  const packages = {};
  for (const [name, expectedVersion] of Object.entries(declared)) {
    const actual = JSON.parse(await fs.readFile(path.join(directory, "node_modules", name, "package.json"), "utf8")).version;
    assert.equal(actual, expectedVersion, `Installed dependency drift: ${name}`);
    packages[name] = actual;
  }
  report.dependencySets ??= [];
  report.dependencySets.push({ name: sdk, lockSha256: sha256(await fs.readFile(path.join(pinned, "package-lock.json"))), packages });
  return path.join(directory, "node_modules");
}

async function bindQuestion(sourceEval, id) {
  const relative = `evals/${sourceEval}/questions.json`;
  const bytes = await fs.readFile(path.join(repository, relative));
  assert.equal(sha256(bytes), manifest.questionFiles[relative], "Replay requires the frozen question file");
  const question = JSON.parse(bytes).questions.find((q) => q.id === id);
  report.question = { sourceEval, id, sha256: sha256(JSON.stringify(question)) };
  return question;
}

async function stagedIndex() {
  const question = await bindQuestion("000-fundamentals/010-staged_index", "q1");
  const historical = JSON.parse(requireArtifact(artifacts, "outputs/failure-pilot/evidence/000-fundamentals/010-staged_index/execution-evidence.json"));
  for (const version of ["1.41.0", "1.44.0"]) {
    const project = path.join(temporary, version);
    const modules = await install(project, version);
    const prefix = `work/failure-pilot/author-data/010-staged_index/runs/2026-09-17T23-17-00-303Z/${version}/`;
    for (const name of ["a", "b", "c", "d", "repair_a", "repair_b", "repair_d"]) {
      const source = requireArtifact(artifacts, `${prefix}${name}.ts`);
      // Bind the exact historical fixture to the published option. Repairs are
      // compared with the recorded minimal repair text, not guessed anew.
      const displayed = name.startsWith("repair_") ? historical.repairs[name.slice(7)] : question.options.find((o) => o.id === name).text.replace(/^```ts\n|\n```$/g, "");
      assert.ok(source.includes(displayed), `Displayed code missing from fixture: ${name}`);
      await fs.writeFile(path.join(project, `${name}.ts`), source);
      await fs.writeFile(path.join(project, `execute_${name}.ts`), requireArtifact(artifacts, `${prefix}execute_${name}.ts`));
      const staticResult = await command(process.execPath, [path.join(modules, "typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--moduleResolution", "bundler", "--module", "esnext", "--target", "es2022", `${name}.ts`], project);
      const execution = await command(process.execPath, ["--experimental-strip-types", `execute_${name}.ts`], project);
      assert.equal(execution.code, 0, clean(execution.stderr));
      const actual = JSON.parse(execution.stdout.trim());
      const expectedStatic = name === "c" || name.startsWith("repair_") ? 0 : 2;
      assert.equal(staticResult.code, expectedStatic, clean(staticResult.stdout));
      if (name === "b") {
        assert.equal(actual.ok, false);
        assert.match(actual.error, /staged is not a function/);
      } else {
        assert.equal(actual.ok, true);
        if (expectedStatic === 0) assert.deepEqual(actual.descriptor, historical.oracle);
        else {
          const table = actual.descriptor.tables[0];
          assert.deepEqual(table.stagedDbIndexes, []);
          assert.ok(table.indexes.some((index) => index.indexDescriptor === "by_workspaceId_and_status"));
        }
      }
      report.observations.push({ sdk: version, variant: name, fixtureSha256: sha256(source), static: { code: staticResult.code, stdout: clean(staticResult.stdout), stderr: clean(staticResult.stderr) }, runtime: actual, runtimeTypecheckBypass: expectedStatic !== 0 });
    }
  }
  report.limitations.push("Native SDK declaration/descriptor execution only. No backend deployment, index activation, or large-table backfill timing is measured.");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startBackend() {
  const binary = path.resolve(flags.get("--backend"));
  report.backendSha256 = sha256(await fs.readFile(binary));
  report.historicalBackendSha256 = "cf8e4761382ab4b758198af6209074cf3d0b5abd84697c27c7e0ab44baff58e7";
  report.matchesHistoricalBackend = report.backendSha256 === report.historicalBackendSha256;
  const instance = `decision-replay-${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  redactions.push(secret);
  const key = await command(binary, ["keygen", "admin-key", "--instance-name", instance, "--instance-secret", secret], temporary);
  assert.equal(key.code, 0, "Backend does not support fresh admin-key generation");
  const admin = key.stdout.trim();
  assert.ok(admin.length > 20, "Backend returned an invalid local admin key");
  redactions.push(admin);
  const port = await freePort();
  let sitePort = await freePort();
  while (sitePort === port) sitePort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const state = path.join(temporary, "backend");
  await fs.mkdir(state);
  let backendError = "", backendSpawnError;
  backend = spawn(binary, ["--interface", "127.0.0.1", "--port", String(port), "--site-proxy-port", String(sitePort), "--convex-origin", url, "--convex-site", `http://127.0.0.1:${sitePort}`, "--instance-name", instance, "--instance-secret", secret, "--disable-beacon", "--local-storage", path.join(state, "storage"), path.join(state, "db.sqlite3")], { cwd: state, env, stdio: ["ignore", "ignore", "pipe"] });
  backend.on("error", (error) => { backendSpawnError = error; });
  backend.stderr.on("data", (data) => backendError = (backendError + data).slice(-12000));
  let healthy = false;
  for (let i = 0; i < 300; i++) {
    if (backendSpawnError) throw backendSpawnError;
    if (backend.exitCode !== null) throw new Error(`Local backend exited: ${clean(backendError)}`);
    try { const response = await fetch(`${url}/version`, { signal: AbortSignal.timeout(500) }); if (response.ok) { healthy = true; report.backendVersion = await response.text(); break; } } catch { /* Startup is polled with a bounded deadline. */ }
    await pause(100);
  }
  assert.ok(healthy, `Local backend failed to start: ${clean(backendError)}`);
  return { url, admin };
}

async function visibility() {
  const question = await bindQuestion("000-fundamentals/000-empty_functions", "q1");
  const origin = "work/bank-revision/foundations-01/runs/2026-09-18T01-28-54-481Z-3d74dc79/000-empty_functions-q1/convex/index.ts";
  const source = requireArtifact(artifacts, origin);
  const displayed = question.context.match(/```ts\n([\s\S]*?)\n```/)[1];
  assert.ok(source.includes(displayed), "Displayed program differs from the recorded fixture");
  const project = path.join(temporary, "visibility");
  // Copy the unchanged source fixture only into the disposable directory. This
  // question has no schema, and no source/schema file is edited in the checkout.
  await fs.cp(path.join(repository, "evals/000-fundamentals/000-empty_functions/answer"), project, { recursive: true, filter: (p) => !["node_modules", ".git", ".convex"].includes(path.basename(p)) && !path.basename(p).startsWith(".env") });
  await fs.writeFile(path.join(project, "convex/index.ts"), source);
  const modules = await install(project, "1.44.0");
  const { url, admin } = await startBackend();
  const deployment = await command(process.execPath, [path.join(modules, "convex/bin/main.js"), "dev", "--once", "--typecheck", "disable", "--url", url, "--admin-key", admin], project);
  assert.equal(deployment.code, 0, clean(deployment.stderr));
  const staticResult = await command(process.execPath, [path.join(modules, "typescript/bin/tsc"), "--noEmit", "-p", "convex/tsconfig.json"], project);
  assert.equal(staticResult.code, 0, clean(staticResult.stdout));
  const { ConvexHttpClient } = await import(pathToFileURL(path.join(modules, "convex/dist/esm/browser/index.js")));
  const client = new ConvexHttpClient(url, { logger: false });
  const calls = {};
  for (const kind of ["Query", "Mutation", "Action"]) {
    for (const visibility of ["public", "private"]) {
      const name = `${visibility}${kind}`;
      try { calls[name] = { ok: true, value: await client[kind.toLowerCase()](`index:${name}`, {}) }; }
      catch (error) { calls[name] = { ok: false, error: clean(error) }; }
      assert.equal(calls[name].ok, visibility === "public");
      if (visibility === "public") assert.equal(calls[name].value, null);
      else assert.match(calls[name].error, /Could not find public function/);
    }
  }
  const internalControl = await client.action("index:bridge", {});
  assert.deepEqual(internalControl, [null, null, null]);
  report.observations.push({ sdk: "1.44.0", fixtureSha256: sha256(source), static: { code: staticResult.code }, deployment: { code: deployment.code, typecheckInitiallyDisabled: true }, calls, internalControl, repairControl: "not applicable: outcome prediction" });
  report.limitations.push("Tests ordinary-client visibility and internal dispatch of the displayed functions. Does not establish authentication or authorization behavior.");
}

try {
  if (mode === "staged-index") await stagedIndex();
  else if (mode === "visibility") await visibility();
  else {
    const { replayAdditional } = await import("./replay-additional.mjs");
    await replayAdditional(mode, { artifacts, temporary, report, clean, command, install, bindQuestion, startBackend });
  }
  report.status = "passed";
} finally {
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => backend.once("close", resolve)), pause(5000)]);
    if (backend.exitCode === null && backend.signalCode === null) {
      backend.kill("SIGKILL");
      await new Promise((resolve) => backend.once("close", resolve));
    }
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
const result = JSON.stringify(report, null, 2) + "\n";
if (flags.has("--output")) await fs.writeFile(path.resolve(flags.get("--output")), result);
console.log(JSON.stringify({ status: report.status, mode, question: report.question, observations: report.observations.length, matchesHistoricalBackend: report.matchesHistoricalBackend, limitations: report.limitations }, null, 2));
