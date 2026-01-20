// Shared types for the guidelines generator system

export interface EvalResult {
  evalName: string;
  passed: boolean;
  expectedFiles: string[];
  outputFiles: string[];
  runLogPath: string;
  taskPath: string;
}

export interface EvalRunResult {
  passed: number;
  failed: number;
  total: number;
  results: EvalResult[];
}

export interface FailureAnalysis {
  analysis: string;
  suggestedGuideline: string;
  confidence: 'high' | 'medium' | 'low';
  relatedLegacyGuidelines: string[];
}

export interface LockFileStatus {
  runId: string;
  pid: number;
  startedAt: string;
  phase: 'startup' | 'construction' | 'refinement' | 'complete';
  iteration: number;
  lastEvalResult?: {
    passed: number;
    failed: number;
    total: number;
  };
  currentAction?: string;
  updatedAt: string;
  // Tracking for plateau detection and checkpointing
  bestPassCount?: number;
  bestIteration?: number;
  stableIterations?: number;
}

export interface ModelStatus {
  model: string;
  provider: string;
  status: 'running' | 'paused' | 'complete' | 'not-started';
  lockFile?: LockFileStatus;
  guidelineTokens?: number;
  lastUpdate?: string;
}

export interface RunOptions {
  model: string;
  provider: string;
  runId: string;
  filter?: string;
  guidelinesPath: string;
}

/**
 * Tracks eval stability across multiple runs to identify flaky vs deterministic failures.
 */
export interface EvalStability {
  evalName: string;
  passCount: number;
  failCount: number;
  // An eval is considered flaky if it has both passes and failures
  isFlaky: boolean;
  // An eval is consistently failing if it fails every time
  isConsistentlyFailing: boolean;
}

/**
 * Checkpoint data saved alongside guidelines to track progress.
 */
export interface CheckpointData {
  passCount: number;
  failCount: number;
  iteration: number;
  timestamp: string;
}

/**
 * Track per-eval results for an iteration
 */
export interface IterationRecord {
  iteration: number;
  runId: string;
  timestamp: string;
  passCount: number;
  failCount: number;
  evalResults: Record<string, boolean>; // evalName -> passed
  guidelinesDiff?: string; // Summary of what changed
}

/**
 * Full history for a model
 */
export interface IterationHistory {
  iterations: IterationRecord[];
}

/**
 * Computed feedback for the incorporator
 */
export interface IterationFeedback {
  previousIteration: number;
  currentIteration: number;
  passCountDelta: number; // +3 means 3 more passing
  evalsFlippedToPass: string[]; // Evals that started passing
  evalsFlippedToFail: string[]; // Evals that regressed
  changesMade: string; // What guidelines changed
}
