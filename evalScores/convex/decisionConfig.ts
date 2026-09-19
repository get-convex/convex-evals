/**
 * Decision reporting stays off for the compatibility deployment. The strict
 * post-migration activation patch changes this literal to true.
 */
export const DECISION_INGESTION_ENABLED = false;

export const MAX_DECISION_RECORD_BATCH = 25;
export const MAX_DECISION_REPETITIONS = 10;
export const MAX_DECISION_RETRIES = 3;
export const MAX_DECISION_TIMEOUT_MS = 120_000;
export const MAX_DECISION_SOURCE_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_DECISION_QUESTION_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES = 8 * 1024 * 1024;
// The compact final envelope omits repeated requests. This still covers the
// 106-question bank at 10 repetitions and 4 attempts per slot with bounded
// provider responses, while maxOutputLength stops gzip bombs before allocation.
export const MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DECISION_OUTPUT_TOKENS = 8_192;

export function assertDecisionIngestionEnabled(
  enabled = DECISION_INGESTION_ENABLED,
): void {
  if (!enabled) {
    throw new Error(
      "Decision ingestion is disabled until the strict kind migration is deployed",
    );
  }
}
