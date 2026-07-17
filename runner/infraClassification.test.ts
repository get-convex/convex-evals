import { describe, expect, test } from "vitest";
import { isInfrastructureStepFailure } from "./scorer";

describe("isInfrastructureStepFailure", () => {
  test("model failures in evals with rate_limit in their path are not infrastructure", () => {
    const tscError =
      "Failed to typecheck code:\n" +
      "/tmp/convex-evals-1/output/m/007-components/001-transactional_rate_limit/convex/index.ts(23,7): " +
      "error TS2353: 'rate' does not exist in type '{ config: RateLimitConfig }'.";
    expect(isInfrastructureStepFailure("tsc", tscError)).toBe(false);
    expect(isInfrastructureStepFailure("deploy", tscError)).toBe(false);
    expect(isInfrastructureStepFailure("install", tscError)).toBe(false);
  });

  test("provider throttling still classifies as infrastructure", () => {
    expect(
      isInfrastructureStepFailure("install", "npm error status code 429"),
    ).toBe(true);
    expect(
      isInfrastructureStepFailure("tsc", "request failed: too many requests"),
    ).toBe(true);
    expect(isInfrastructureStepFailure("deploy", "connect ECONNREFUSED")).toBe(
      true,
    );
  });
});
