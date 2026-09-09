import { appendFileSync } from "node:fs";

export const GRADER_EVENTS_PATH_ENV = "CONVEX_EVAL_GRADER_EVENTS_PATH";

export type GraderEvent =
  | { kind: "infrastructure"; code: string; message: string }
  | {
      kind: "vitest-end";
      reason: "passed" | "failed" | "interrupted";
      unhandledErrors: string[];
    };

/** Only trusted grader code writes this channel; candidate output is not parsed. */
export function recordGraderEvent(event: GraderEvent): void {
  const path = process.env[GRADER_EVENTS_PATH_ENV];
  // Direct unit tests and standalone inspector calls have no scoring process.
  if (path) appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export class GraderInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderInfrastructureError";
  }
}

/**
 * A grader could not evaluate the answer. Record this before throwing because
 * Vitest turns every thrown Error, including a typed one, into a failed test.
 * Never use this for a wrong candidate result or an expected contract failure.
 */
export function failGraderInfrastructure(
  message: string,
  code = "grader",
): never {
  recordGraderEvent({ kind: "infrastructure", code, message });
  throw new GraderInfrastructureError(message);
}
