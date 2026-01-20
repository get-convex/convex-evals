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
