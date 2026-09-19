"use node";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  questionBankSchema,
  type LoadedBank,
} from "../../runner/decisions/questions.js";
import { decisionBankManifestSchema } from "../../runner/decisions/coverage.js";
import { DECISION_PROTOCOL } from "../../runner/decisions/protocol.js";
import { SYSTEM_PROMPT } from "../../runner/models/index.js";
import {
  BENCHMARK_PROTOCOL_VERSION,
  isBenchmarkRuntimeArtifact,
} from "../../runner/benchmark.js";
import {
  recomputeSnapshotBenchmark,
  type DecisionSourceSnapshot,
} from "../../runner/decisions/source.js";
import { sameJson } from "./decisionIdentity.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotShape = z.strictObject({
  artifactVersion: z.literal(1),
  kind: z.literal("decision-source"),
  benchmark: z.strictObject({
    version: digest,
    evalCount: z.number().int().positive(),
  }),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sharedProtocol: z.strictObject({
    version: z.string(),
    systemPrompt: z.string(),
  }),
  protocol: z.unknown(),
  coverage: decisionBankManifestSchema,
  banks: z.array(z.record(z.string(), z.unknown())).min(1),
  guidelines: z.string(),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        encoding: z.enum(["utf8", "base64"]),
        content: z.string(),
        sha256: digest,
      }),
    )
    .min(1)
    .max(10000),
});

/** Hash checks alone do not bind convenient parsed projections to archived
 * source. Validate both, then grade using the reconstructed trusted projection. */
export function validateDecisionSnapshot(
  input: unknown,
): DecisionSourceSnapshot {
  const parsed = snapshotShape.parse(input);
  if (
    !sameJson(parsed.protocol, DECISION_PROTOCOL) ||
    parsed.sharedProtocol.version !== BENCHMARK_PROTOCOL_VERSION ||
    parsed.sharedProtocol.systemPrompt !== SYSTEM_PROMPT
  ) {
    throw new Error("Unsupported decision source protocol");
  }
  const banks: LoadedBank[] = parsed.banks.map((value) => {
    const { sourceFingerprint, ...bank } = value;
    return {
      ...questionBankSchema.parse(bank),
      sourceFingerprint: digest.parse(sourceFingerprint),
    };
  });
  const snapshot: DecisionSourceSnapshot = {
    ...parsed,
    banks,
    protocol: DECISION_PROTOCOL,
  };
  if (recomputeSnapshotBenchmark(snapshot) !== snapshot.benchmark.version) {
    throw new Error("Decision source does not reproduce its shared benchmark");
  }
  const files = new Map(
    parsed.files.map((file) => [
      file.path,
      Buffer.from(file.content, file.encoding),
    ]),
  );
  const bytes = (path: string) => {
    const content = files.get(path);
    if (!content) throw new Error(`Missing archived source: ${path}`);
    return content;
  };
  const text = (path: string) =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes(path));
  if (
    parsed.guidelines !== text("runner/models/guidelines.md") ||
    !sameJson(parsed.coverage, JSON.parse(text("decision-bank.json")))
  ) {
    throw new Error(
      "Source guidelines or coverage projection differs from archived bytes",
    );
  }
  const paths = [...files.keys()];
  const allSources = paths
    .filter((path) => /^evals\/[^/]+\/[^/]+\/TASK\.txt$/.test(path))
    .map((path) => path.slice(6, -9));
  const declared = parsed.coverage.banks.map((bank) => bank.sourceEval);
  const omitted = parsed.coverage.omittedSources.map(
    (source) => source.sourceEval,
  );
  if (
    new Set([...declared, ...omitted]).size !==
      declared.length + omitted.length ||
    parsed.coverage.codingEvalCount !== allSources.length ||
    !sameJson([...declared, ...omitted].sort(), [...allSources].sort()) ||
    !sameJson([...declared].sort(), banks.map((bank) => bank.sourceEval).sort())
  ) {
    throw new Error(
      "Decision source coverage does not match the complete archived suite",
    );
  }
  const bankPaths = paths.filter((path) =>
    /^evals\/[^/]+\/[^/]+\/questions\.json$/.test(path),
  );
  if (
    !sameJson(
      bankPaths.sort(),
      declared.map((source) => `evals/${source}/questions.json`).sort(),
    )
  ) {
    throw new Error("Archived question banks differ from accepted coverage");
  }
  // Reproduce sourceFingerprint's directory traversal without extracting or
  // executing submitted files. Directory ordering differs from global sorting.
  const ordered = (prefix: string): string[] => {
    const descendants = paths.filter((path) => path.startsWith(`${prefix}/`));
    const children = [
      ...new Set(
        descendants.map((path) => path.slice(prefix.length + 1).split("/")[0]),
      ),
    ].sort((a, b) => a.localeCompare(b));
    return children
      .filter(
        (name) =>
          ![
            "questions.json",
            "node_modules",
            "_generated",
            "__pycache__",
            "backend",
          ].includes(name) && !isBenchmarkRuntimeArtifact(name),
      )
      .flatMap((name) =>
        files.has(`${prefix}/${name}`)
          ? [`${prefix}/${name}`]
          : ordered(`${prefix}/${name}`),
      );
  };
  for (const bank of banks) {
    const { sourceFingerprint, ...projection } = bank;
    const path = `evals/${bank.sourceEval}/questions.json`;
    if (
      !sameJson(projection, questionBankSchema.parse(JSON.parse(text(path))))
    ) {
      throw new Error(
        `Question projection differs from archived source: ${bank.sourceEval}`,
      );
    }
    const coverage = parsed.coverage.banks.find(
      (item) => item.sourceEval === bank.sourceEval,
    )!;
    const hash = createHash("sha256");
    const prefix = `evals/${bank.sourceEval}`;
    for (const path of ordered(prefix))
      hash
        .update(path.slice(prefix.length + 1))
        .update("\0")
        .update(bytes(path))
        .update("\0");
    const fingerprint = hash.digest("hex");
    if (
      fingerprint !== sourceFingerprint ||
      fingerprint !== coverage.sourceFingerprint ||
      createHash("sha256").update(bytes(path)).digest("hex") !==
        coverage.bankSha256 ||
      !sameJson(
        [...coverage.questionIds].sort(),
        bank.questions.map((question) => question.id).sort(),
      )
    ) {
      throw new Error(
        `Question coverage or source fingerprint mismatch: ${bank.sourceEval}`,
      );
    }
  }
  return snapshot;
}
