export interface EvalScore {
  name: string;
  score: number;
  improvements: number;
  regressions: number;
  diff: unknown;
  _longest_score_name?: number;
}

export interface EvalSummary {
  project_name: string;
  project_id: string | null;
  experiment_id: string | null;
  experiment_name: string | null;
  project_url: string | null;
  experiment_url: string | null;
  comparison_experiment_name: string | null;
  scores: Record<string, EvalScore>;
  metrics: Record<string, unknown>;
}

export interface IndividualResult {
  category: string;
  name: string;
  passed: boolean;
  tests_pass_score: number;
  failure_reason: string | null;
  directory_path: string | null;
  scores: Record<string, number>;
}

export interface CategorySummary {
  total: number;
  passed: number;
  failed: number;
}

export interface RunStats {
  total_tests: number;
  total_passed: number;
  total_failed: number;
  overall_score: number;
}

export interface EvalResult {
  summary: EvalSummary;
  tempdir: string;
  model_name?: string;
  individual_results?: IndividualResult[];
  category_summaries?: Record<string, CategorySummary>;
  run_stats?: RunStats;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

export function getScoreStatus(
  score: number,
): "excellent" | "good" | "fair" | "poor" {
  if (score >= 0.9) return "excellent";
  if (score >= 0.7) return "good";
  if (score >= 0.5) return "fair";
  return "poor";
}

export function getScoreIcon(score: number): string {
  if (score >= 0.9) return "🟢";
  if (score >= 0.7) return "🟡";
  if (score >= 0.5) return "🟠";
  return "🔴";
}

export function getPassFailIcon(passed: boolean): string {
  return passed ? "✅" : "❌";
}

export function parseFailureReasons(result: IndividualResult): string[] {
  const failureReasons: string[] = [];

  if (result.passed) return failureReasons;

  if (result.scores) {
    Object.entries(result.scores).forEach(([key, value]) => {
      if (value === 0) {
        const keyLower = key.toLowerCase();
        if (keyLower.includes("test")) failureReasons.push("Tests");
        if (keyLower.includes("lint")) failureReasons.push("Linting");
        if (keyLower.includes("compile")) failureReasons.push("Compile");
        if (keyLower.includes("tsc")) failureReasons.push("TypeScript");
        if (keyLower.includes("filesystem")) failureReasons.push("Files");
        if (keyLower.includes("valid")) failureReasons.push("Validation");
      }
    });
  }

  if (result.failure_reason) {
    const reason = result.failure_reason.toLowerCase();
    if (reason.includes("tsc") && !failureReasons.includes("TypeScript")) {
      failureReasons.push("TypeScript");
    }
    if (reason.includes("lint") && !failureReasons.includes("Linting")) {
      failureReasons.push("Linting");
    }
    if (reason.includes("test") && !failureReasons.includes("Tests")) {
      failureReasons.push("Tests");
    }
    if (
      reason.includes("convex dev") &&
      !failureReasons.includes("Convex Dev")
    ) {
      failureReasons.push("Convex Dev");
    }
  }

  return failureReasons;
}
