import type { Id } from "../convex/types";

// Step name literals
export type StepName = "filesystem" | "install" | "deploy" | "tsc" | "eslint" | "tests";

// Status discriminated unions
export type RunStatus =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "completed"; durationMs: number }
  | { kind: "failed"; failureReason: string; durationMs: number };

export type EvalStatus =
  | { kind: "pending" }
  | { kind: "running"; outputStorageId?: string }
  | {
      kind: "passed";
      durationMs: number;
      generationDurationMs?: number;
      outputStorageId?: string;
    }
  | {
      kind: "failed";
      failureReason: string;
      durationMs: number;
      generationDurationMs?: number;
      outputStorageId?: string;
    };

export type StepStatus =
  | { kind: "running" }
  | { kind: "passed"; durationMs: number }
  | { kind: "failed"; failureReason: string; durationMs: number }
  | { kind: "skipped" };

// Step type
export interface Step {
  _id: Id<"steps">;
  evalId: Id<"evals">;
  name: StepName;
  status: StepStatus;
  _creationTime: number;
}

// Eval type
export interface Eval {
  _id: Id<"evals">;
  runId: Id<"runs">;
  evalPath: string;
  category: string;
  name: string;
  status: EvalStatus;
  task?: string;
  evalSourceStorageId?: string;
  _creationTime: number;
  steps?: Step[];
}

// Run type
export interface Run {
  _id: Id<"runs">;
  modelId?: Id<"models">;
  model: string;
  formattedName?: string;
  provider?: string;
  runId?: string;
  plannedEvals: string[];
  status: RunStatus;
  experiment?: "no_guidelines";
  _creationTime: number;
  evalCounts?: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  evals?: Eval[];
}

// Helper functions
export function getScoreStatus(
  score: number,
): "excellent" | "good" | "fair" | "poor" {
  if (score >= 0.9) return "excellent";
  if (score >= 0.7) return "good";
  if (score >= 0.5) return "fair";
  return "poor";
}

export function getRunStatusIcon(status: RunStatus): string {
  if (status.kind === "pending") return "⏳";
  if (status.kind === "running") return "🔄";
  if (status.kind === "completed") return "✅";
  return "❌";
}

export function getEvalStatusIcon(status: EvalStatus): string {
  if (status.kind === "pending") return "⏳";
  if (status.kind === "running") return "🔄";
  if (status.kind === "passed") return "✅";
  return "❌";
}

export function getStepStatusIcon(status: StepStatus): string {
  if (status.kind === "running") return "🔄";
  if (status.kind === "passed") return "✅";
  if (status.kind === "skipped") return "⏭️";
  return "❌";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatStepName(name: StepName): string {
  const names: Record<StepName, string> = {
    filesystem: "Filesystem",
    install: "Install",
    deploy: "Deploy",
    tsc: "TypeScript",
    eslint: "ESLint",
    tests: "Tests",
  };
  return names[name];
}
