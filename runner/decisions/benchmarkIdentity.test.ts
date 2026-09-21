import { describe, expect, it } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  computeBenchmarkDefinition,
  discoverBenchmarkEvalPaths,
} from "../benchmark.js";
import {
  createDecisionSourceSnapshot,
  decisionBenchmarkIdentity,
  recomputeSnapshotBenchmark,
  type DecisionSourceSnapshot,
  sha256,
} from "./source.js";
import { DECISION_PROTOCOL } from "./protocol.js";

const root = resolve(import.meta.dir, "../..");

describe("independent benchmark identities", () => {
  it("reproduces the published coding identity from the accepted suite", () => {
    expect(
      computeBenchmarkDefinition(discoverBenchmarkEvalPaths(root), root),
    ).toEqual({
      version:
        "41d65c9b4f5bcdb97bc5c6ead5aa054e335b2eab6abc897b352b97b98b016fb3",
      evalCount: 112,
    });
  });

  it("hashes decision semantics separately from archived implementation and unrelated coding sources", () => {
    const snapshot = createDecisionSourceSnapshot(root, "a".repeat(40));
    expect(snapshot.artifactVersion).toBe(2);
    const original = snapshot.benchmark.version;
    const changed = structuredClone(snapshot);
    // Archive content is integrity-checked, but reporting code has no score semantics.
    changed.sourceCommit = "b".repeat(40);
    const report = changed.files.find(
      (file) => file.path === "runner/decisions/report.ts",
    )!;
    report.content += "\n// Reporting-only edit\n";
    report.sha256 = sha256(Buffer.from(report.content, report.encoding));
    const covered = new Set(
      changed.banks.map((bank) => `evals/${bank.sourceEval}/TASK.txt`),
    );
    const unrelatedTask = changed.files.find(
      (file) => file.path.endsWith("/TASK.txt") && !covered.has(file.path),
    )!;
    unrelatedTask.content += "\nUnrelated coding task edit\n";
    unrelatedTask.sha256 = sha256(
      Buffer.from(unrelatedTask.content, unrelatedTask.encoding),
    );
    expect(recomputeSnapshotBenchmark(changed)).toBe(original);
    expect(
      decisionBenchmarkIdentity({
        ...snapshot,
        protocol: { ...DECISION_PROTOCOL, scoring: "different" },
      }),
    ).not.toBe(original);
    expect(
      decisionBenchmarkIdentity({ ...snapshot, guidelines: "different" }),
    ).not.toBe(original);
    changed.banks[0].questions[0].correctOptionId = "different";
    expect(decisionBenchmarkIdentity(changed)).not.toBe(original);
    const source = structuredClone(snapshot);
    source.banks[0].sourceFingerprint = "f".repeat(64);
    expect(decisionBenchmarkIdentity(source)).not.toBe(original);
  });

  it("keeps frozen historical runtime contributions stable when local files change or disappear", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "coding-identity-runtime-"),
    );
    try {
      const evalPath = "evals/000-fundamentals/005-function_calling";
      mkdirSync(join(temporaryRoot, evalPath, "answer"), { recursive: true });
      mkdirSync(join(temporaryRoot, "runner/models"), { recursive: true });
      writeFileSync(
        join(temporaryRoot, "runner/models/guidelines.md"),
        "Fixture guidance",
      );
      writeFileSync(
        join(temporaryRoot, evalPath, "TASK.txt"),
        "Fixture coding task",
      );
      const before = computeBenchmarkDefinition([evalPath], temporaryRoot);
      writeFileSync(
        join(temporaryRoot, evalPath, "answer/convex_local_backend.sqlite3"),
        "new local database",
      );
      writeFileSync(
        join(temporaryRoot, evalPath, "answer/backend.stdout.log"),
        "new logs",
      );
      writeFileSync(
        join(temporaryRoot, evalPath, "questions.json"),
        "new decisions",
      );
      expect(computeBenchmarkDefinition([evalPath], temporaryRoot)).toEqual(
        before,
      );
      rmSync(join(temporaryRoot, evalPath, "answer/backend.stdout.log"));
      expect(computeBenchmarkDefinition([evalPath], temporaryRoot)).toEqual(
        before,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the legacy shared v4 algorithm independent of coding protocol 3", () => {
    const modern = createDecisionSourceSnapshot(root, "a".repeat(40));
    const { identityFormat: _, ...base } = modern;
    const legacy: DecisionSourceSnapshot = { ...base, artifactVersion: 1 };
    const hash = recomputeSnapshotBenchmark(legacy);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(modern.benchmark.version);
    const tampered = structuredClone(legacy);
    tampered.files[0].content += "tampered";
    expect(() => recomputeSnapshotBenchmark(tampered)).toThrow();
    expect(() =>
      recomputeSnapshotBenchmark({
        ...legacy,
        sharedProtocol: { ...legacy.sharedProtocol, version: "3" },
      }),
    ).toThrow("Unsupported shared benchmark protocol");
  });
});
