// Only trusted inspectors import this module. Class identity, rather than an
// error string authored by the candidate, identifies an unsupported probe path.
export class ProbeUnsupportedError extends Error {}

// A trusted inspector can identify a missing required candidate artifact before
// any module import starts. Keep that task failure separate from inspector bugs.
export class ProbeCandidateError extends Error {}

export function candidateProbeFailure(message) {
  throw new ProbeCandidateError(message);
}

const unsupported = [];
let reportUnsupported = () => {};

export function setUnsupportedProbeReporter(report) {
  reportUnsupported = report;
}

export function unsupportedProbeErrors() {
  return [...unsupported];
}

export function unsupportedProbe(message) {
  // Candidate catch-and-fallback code cannot turn missing probe support into a
  // passing result or an ordinary assertion failure later in the inspector.
  unsupported.push(message);
  // The wrapper's native log marker survives an uncatchable resource failure
  // after candidate catch-and-retry code. The final envelope may never run.
  reportUnsupported();
  throw new ProbeUnsupportedError(message);
}
