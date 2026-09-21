import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createDecisionSourceSnapshot,
  recomputeSnapshotBenchmark,
  type DecisionSourceSnapshot,
} from "./source.js";
import { validateDecisionSnapshot } from "../../evalScores/convex/decisionSourceValidation.js";
import { sameJson } from "../../evalScores/convex/decisionIdentity.js";

let snapshot: DecisionSourceSnapshot;
beforeAll(() => {
  snapshot = createDecisionSourceSnapshot(
    fileURLToPath(new URL("../../", import.meta.url)),
    "1".repeat(40),
  );
});

// An attacker can recompute a public hash. Projection checks must still reject
// forged parsed values that disagree with archived question/source bytes.
function withRecomputedIdentity(
  snapshot: DecisionSourceSnapshot,
): DecisionSourceSnapshot {
  return {
    ...snapshot,
    benchmark: {
      ...snapshot.benchmark,
      version: recomputeSnapshotBenchmark(snapshot),
    },
  };
}

describe("hosted decision source binding", () => {
  it("validates the complete checked-in source snapshot without extracting code", () => {
    const validated = validateDecisionSnapshot(snapshot);
    expect(validated.banks).toHaveLength(90);
    expect(validated.banks.flatMap((bank) => bank.questions)).toHaveLength(106);
  });

  it("rejects a changed parsed answer key even when the archived bytes still hash correctly", () => {
    const altered = structuredClone(snapshot);
    const question = altered.banks[0].questions[0];
    question.correctOptionId = question.options.find(
      (option) => option.id !== question.correctOptionId,
    )!.id;
    expect(() =>
      validateDecisionSnapshot(withRecomputedIdentity(altered)),
    ).toThrow("projection differs");
  });

  it("rejects changed question wording, guidelines, coverage and duplicate parsed banks", () => {
    const wording = structuredClone(snapshot);
    wording.banks[0].questions[0].question += " Added unreviewed hint.";
    expect(() =>
      validateDecisionSnapshot(withRecomputedIdentity(wording)),
    ).toThrow("projection differs");
    const guidelines = { ...snapshot, guidelines: "Changed instructions" };
    expect(() =>
      validateDecisionSnapshot(withRecomputedIdentity(guidelines)),
    ).toThrow("projection differs");
    expect(() =>
      validateDecisionSnapshot({ ...snapshot, coverage: {} }),
    ).toThrow();
    expect(() =>
      validateDecisionSnapshot(
        withRecomputedIdentity({
          ...snapshot,
          banks: [...snapshot.banks, snapshot.banks[0]],
        }),
      ),
    ).toThrow("coverage");
  });

  it("rejects unsupported protocol and forged source fingerprints", () => {
    expect(() =>
      validateDecisionSnapshot({
        ...snapshot,
        protocol: { ...snapshot.protocol, version: 999 },
      }),
    ).toThrow("Unsupported");
    const changed = structuredClone(snapshot);
    changed.banks[0].sourceFingerprint = "f".repeat(64);
    expect(() =>
      validateDecisionSnapshot(withRecomputedIdentity(changed)),
    ).toThrow("fingerprint mismatch");
  });

  it("ignores object insertion order while preserving meaningful array order", () => {
    expect(
      sameJson(
        { b: [1, { z: 2, a: 3 }], a: null },
        { a: null, b: [1, { a: 3, z: 2 }] },
      ),
    ).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });
});
