import { describe, expect, it } from "vitest";
import type { CodingEval } from "./documentKinds";
import { computeRunCostUsd } from "./scoringUtils";

function evalWith(
  kind: "passed" | "failed",
  raw: Record<string, unknown>,
): CodingEval {
  return {
    kind: "coding",
    status: { kind, durationMs: 1, failureReason: "fixture", usage: { raw } },
  } as CodingEval;
}

describe("run cost for unanswered evals", () => {
  it.each(["empty_response", "rate_limit", "transient_error", "error"])(
    "estimates unanswered %s evals instead of using discarded charges",
    (outcome) => {
      const unanswered = evalWith("failed", {
        cost: 10,
        providerAttempts: [{ outcome }, { outcome }, { outcome }],
      });
      expect(
        computeRunCostUsd([evalWith("passed", { cost: 0.25 }), unanswered]),
      ).toBe(0.5);
      expect(computeRunCostUsd([unanswered])).toBeNull();
    },
  );

  it("uses the same-run mean including answers that fail grading", () => {
    const unanswered = evalWith("failed", {
      providerAttempts: [{ outcome: "empty_response" }],
    });
    expect(
      computeRunCostUsd([
        evalWith("passed", { cost: 1 }),
        evalWith("failed", {
          cost: 3,
          providerAttempts: [{ outcome: "success" }],
        }),
        unanswered,
        unanswered,
      ]),
    ).toBe(8);
  });

  it("includes a successful generation that fails grading after a retry", () => {
    const graded = evalWith("failed", {
      cost: 0.5,
      providerAttempts: [{ outcome: "empty_response" }, { outcome: "success" }],
    });
    expect(
      computeRunCostUsd([evalWith("passed", { cost: 0.25 }), graded]),
    ).toBe(0.75);
  });

  it.each([
    {},
    { providerAttempts: [] },
    { providerAttempts: [{ outcome: "success" }] },
    { providerAttempts: [{ outcome: "unrecognized" }] },
    { providerAttempts: [null] },
  ])(
    "keeps missing costs unknown without evidence of a failed generation: %j",
    (raw) => {
      expect(
        computeRunCostUsd([
          evalWith("passed", { cost: 0.25 }),
          evalWith("failed", raw),
        ]),
      ).toBeNull();
    },
  );
});
