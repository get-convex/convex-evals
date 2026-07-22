export type HistoricalBenchmarkDefinition = {
  version: string;
  signature: string;
  effectiveAt: number;
  evalCount: number;
};

// These cohorts come from a read-only audit of all 2,753 pre-versioning
// production runs. Each signature is SHA-256(sorted plannedEvals), truncated
// to 12 hex characters. Together they cover 2,745 full-suite runs; the eight
// partial or one-off runs fall back to the suite active on their run date.
export const HISTORICAL_BENCHMARKS: HistoricalBenchmarkDefinition[] = [
  {
    version: "reconstructed-dbe4c5df23ab",
    signature: "dbe4c5df23ab",
    effectiveAt: 1769748169019.7,
    evalCount: 66,
  },
  {
    version: "reconstructed-420f3b10b7e8",
    signature: "420f3b10b7e8",
    effectiveAt: 1773297364508.129,
    evalCount: 72,
  },
  {
    version: "reconstructed-166a984340dd",
    signature: "166a984340dd",
    effectiveAt: 1774500805982.4834,
    evalCount: 74,
  },
  {
    version: "reconstructed-59c198e24bd1",
    signature: "59c198e24bd1",
    effectiveAt: 1781503119895.8618,
    evalCount: 76,
  },
  {
    version: "reconstructed-00c84b4abc2e",
    signature: "00c84b4abc2e",
    effectiveAt: 1783934023287.506,
    evalCount: 77,
  },
  {
    version: "reconstructed-ce6860638b77",
    signature: "ce6860638b77",
    effectiveAt: 1784005544845.2983,
    evalCount: 79,
  },
  {
    version: "reconstructed-af44faf27779",
    signature: "af44faf27779",
    effectiveAt: 1784178459645.1948,
    evalCount: 81,
  },
  {
    version: "reconstructed-82ad3a317365",
    signature: "82ad3a317365",
    effectiveAt: 1784191995614.2566,
    evalCount: 82,
  },
  {
    version: "reconstructed-648691bfcb76",
    signature: "648691bfcb76",
    effectiveAt: 1784264509697.1482,
    evalCount: 93,
  },
  {
    version: "reconstructed-512e2dea5152",
    signature: "512e2dea5152",
    effectiveAt: 1784291616531.5215,
    evalCount: 97,
  },
  {
    version: "reconstructed-9e095e59f6d8",
    signature: "9e095e59f6d8",
    effectiveAt: 1784524746729.0854,
    evalCount: 109,
  },
];

export const UNMINTED_BENCHMARK_VERSION = "unminted";

export async function plannedEvalSignature(
  plannedEvals: string[],
): Promise<string> {
  const input = new TextEncoder().encode([...plannedEvals].sort().join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function historicalBenchmarkForRun(
  plannedEvals: string[],
  creationTime: number,
): Promise<HistoricalBenchmarkDefinition> {
  const signature = await plannedEvalSignature(plannedEvals);
  const exact = HISTORICAL_BENCHMARKS.find(
    (benchmark) => benchmark.signature === signature,
  );
  if (exact) return exact;

  // Partial historical runs cannot match a full-suite signature. Link them to
  // the suite active at the time; aggregation still excludes them because
  // their planned eval count does not match the version's evalCount.
  return (
    [...HISTORICAL_BENCHMARKS]
      .reverse()
      .find((benchmark) => benchmark.effectiveAt <= creationTime) ??
    HISTORICAL_BENCHMARKS[0]
  );
}
