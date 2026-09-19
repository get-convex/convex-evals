import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BENCHMARK_DECISION_SOURCE_FILES,
  BENCHMARK_DECISION_BACKEND_FILES,
  BENCHMARK_PROTOCOL_VERSION,
  computeBenchmarkDefinition,
  discoverBenchmarkEvalPaths,
  isBenchmarkRuntimeArtifact,
  type BenchmarkDefinition,
} from "../benchmark.js";
import { SYSTEM_PROMPT } from "../models/index.js";
import { DECISION_PROTOCOL } from "./protocol.js";
import { loadQuestionBanks, type LoadedBank } from "./questions.js";
import { readDecisionDefinition } from "./coverage.js";

export interface SourceFile {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
}

export interface DecisionSourceSnapshot {
  artifactVersion: 1;
  kind: "decision-source";
  benchmark: BenchmarkDefinition;
  sourceCommit: string;
  sharedProtocol: { version: string; systemPrompt: string };
  protocol: typeof DECISION_PROTOCOL;
  coverage: unknown;
  banks: LoadedBank[];
  guidelines: string;
  files: SourceFile[];
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function assertSafeSourcePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid source file path");
  if (
    parts.some(
      (part) =>
        part.startsWith(".env") ||
        part === ".git" ||
        part === ".convex" ||
        [
          "backend",
          "node_modules",
          "_generated",
          "__pycache__",
          "credentials",
          ".DS_Store",
        ].includes(part) ||
        /^output(?:s|-|$)/.test(part) ||
        /\.(?:pem|key|sqlite|sqlite3|db)$/.test(part),
    )
  )
    throw new Error(`Sensitive or runtime file cannot be published: ${path}`);
  const supported =
    path.startsWith("evals/") ||
    [
      "decision-bank.json",
      "runner/models/guidelines.md",
      "runner/models/index.ts",
      "runner/benchmark.ts",
    ].includes(path) ||
    BENCHMARK_DECISION_SOURCE_FILES.some(
      (file) => path === `runner/decisions/${file}`,
    ) ||
    BENCHMARK_DECISION_BACKEND_FILES.some(
      (file) => path === `evalScores/convex/${file}`,
    );
  if (!supported)
    throw new Error(`Unrecognized benchmark source path: ${path}`);
}

/** Publish the exact source needed to inspect requests and recompute the one
 * shared suite hash. Environment files and runtime output are never traversed. */
export function createDecisionSourceSnapshot(
  root: string,
  sourceCommit: string,
): DecisionSourceSnapshot {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error("Expected a source commit SHA");
  const inventory = loadQuestionBanks(root);
  const coverage = readDecisionDefinition(root, inventory);
  const errors = [...inventory.errors, ...coverage.errors];
  if (errors.length || !coverage.definition)
    throw new Error(`Invalid accepted decision bank: ${errors.join("; ")}`);
  const files: SourceFile[] = [];
  const add = (path: string): void => {
    // Reject, rather than skip, unpublishable files that affect the suite hash.
    // Otherwise the uploaded snapshot could claim a hash it cannot reproduce.
    assertSafeSourcePath(path);
    const bytes = readFileSync(join(root, path));
    const text = bytes.toString("utf8");
    const encoding = bytes.equals(Buffer.from(text)) ? "utf8" : "base64";
    const content = bytes.toString(encoding);
    files.push({ path, encoding, content, sha256: sha256(bytes) });
  };
  const walk = (path: string): void => {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && isBenchmarkRuntimeArtifact(entry.name)) continue;
      if (
        entry.isDirectory() &&
        ["node_modules", "_generated", "__pycache__"].includes(entry.name)
      )
        continue;
      if (entry.isSymbolicLink())
        throw new Error(
          `Symlink is not a portable benchmark source: ${path}/${entry.name}`,
        );
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) add(child);
    }
  };
  const evalPaths = discoverBenchmarkEvalPaths(root);
  for (const path of evalPaths) walk(path);
  for (const file of BENCHMARK_DECISION_SOURCE_FILES)
    add(`runner/decisions/${file}`);
  for (const file of BENCHMARK_DECISION_BACKEND_FILES) {
    const path = `evalScores/convex/${file}`;
    if (existsSync(join(root, path))) add(path);
  }
  for (const file of [
    "decision-bank.json",
    "runner/models/guidelines.md",
    "runner/models/index.ts",
    "runner/benchmark.ts",
  ])
    add(file);
  const snapshot: DecisionSourceSnapshot = {
    artifactVersion: 1,
    kind: "decision-source",
    benchmark: computeBenchmarkDefinition(evalPaths, root),
    sourceCommit,
    sharedProtocol: {
      version: BENCHMARK_PROTOCOL_VERSION,
      systemPrompt: SYSTEM_PROMPT,
    },
    protocol: DECISION_PROTOCOL,
    coverage: JSON.parse(
      readFileSync(join(root, "decision-bank.json"), "utf8"),
    ) as unknown,
    banks: inventory.banks,
    guidelines: readFileSync(join(root, "runner/models/guidelines.md"), "utf8"),
    files,
  };
  if (recomputeSnapshotBenchmark(snapshot) !== snapshot.benchmark.version)
    throw new Error(
      "Source snapshot does not reproduce the shared benchmark hash",
    );
  return snapshot;
}

/** Hash archived bytes directly; never execute or extract uploaded source. */
export function recomputeSnapshotBenchmark(
  snapshot: DecisionSourceSnapshot,
): string {
  const files = new Map<string, Buffer>();
  for (const file of snapshot.files) {
    assertSafeSourcePath(file.path);
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      file.path.includes("\\")
    )
      throw new Error("Invalid source file path");
    if (files.has(file.path))
      throw new Error(`Duplicate source path: ${file.path}`);
    if (!["utf8", "base64"].includes(file.encoding))
      throw new Error("Invalid source encoding");
    const bytes = Buffer.from(file.content, file.encoding);
    if (bytes.toString(file.encoding) !== file.content)
      throw new Error("Noncanonical source encoding");
    if (sha256(bytes) !== file.sha256)
      throw new Error(`Source hash mismatch: ${file.path}`);
    files.set(file.path, bytes);
  }
  const required = (path: string): Buffer => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`Missing source: ${path}`);
    return text;
  };
  if (snapshot.sharedProtocol.version !== BENCHMARK_PROTOCOL_VERSION)
    throw new Error("Unsupported shared benchmark protocol");
  const hasher = createHash("sha256");
  hasher.update(`protocol\0${snapshot.sharedProtocol.version}\0`);
  hasher.update(`system-prompt\0${snapshot.sharedProtocol.systemPrompt}\0`);
  hasher
    .update("guidelines\0")
    .update(required("runner/models/guidelines.md"))
    .update("\0");
  for (const file of BENCHMARK_DECISION_SOURCE_FILES) {
    hasher
      .update(`decision-source\0${file}\0`)
      .update(required(`runner/decisions/${file}`))
      .update("\0");
  }
  for (const file of BENCHMARK_DECISION_BACKEND_FILES) {
    const path = `evalScores/convex/${file}`;
    if (files.has(path))
      hasher
        .update(`decision-backend\0${file}\0`)
        .update(required(path))
        .update("\0");
  }
  hasher
    .update("decision-coverage\0")
    .update(required("decision-bank.json"))
    .update("\0");
  const evalPaths = [...files.keys()]
    .filter((path) => /^evals\/[^/]+\/[^/]+\/TASK\.txt$/.test(path))
    .map((path) => path.slice(0, -"/TASK.txt".length))
    .sort();
  if (evalPaths.length !== snapshot.benchmark.evalCount)
    throw new Error("Snapshot coding eval count mismatch");
  // Match the directory traversal used by computeBenchmarkDefinition, including
  // directory ordering. A global filename sort has different punctuation rules.
  const orderedFiles = (prefix: string): string[] => {
    const descendants = [...files.keys()].filter((path) =>
      path.startsWith(`${prefix}/`),
    );
    const children = [
      ...new Set(
        descendants.map((path) => path.slice(prefix.length + 1).split("/")[0]),
      ),
    ].sort((a, b) => a.localeCompare(b));
    return children.flatMap((name) =>
      files.has(`${prefix}/${name}`)
        ? [`${prefix}/${name}`]
        : orderedFiles(`${prefix}/${name}`),
    );
  };
  for (const path of evalPaths) {
    hasher.update(`eval\0${path}\0`);
    for (const file of orderedFiles(path))
      hasher.update(file).update("\0").update(required(file)).update("\0");
  }
  return hasher.digest("hex");
}
