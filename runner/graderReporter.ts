import type { Reporter } from "vitest/node";
import { recordGraderEvent } from "../grader/infrastructure.js";

/** The JSON reporter omits unhandled errors, even when they make Vitest exit 1. */
export default class GraderReporter implements Reporter {
  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]> = (
    _testModules,
    unhandledErrors,
    reason,
  ) => {
    recordGraderEvent({
      kind: "vitest-end",
      reason,
      unhandledErrors: unhandledErrors.map(
        (error) =>
          `${error.name ?? "Error"}: ${error.message ?? "Unknown unhandled error"}`,
      ),
    });
  };
}
