export const WEB_EXPERIMENT = "no_guidelines_with_web";

export function isWebResearchExperiment(
  experiment: string | undefined,
): boolean {
  return experiment === WEB_EXPERIMENT;
}

/** Reject unavailable experiments before model calls or result reporting. */
export function validateExperimentConfiguration(
  experiment: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  // Old launch commands must fail rather than silently run the default harness.
  if (env.EVALS_NATIVE_HARNESS || env.EVALS_NATIVE_WEB_SEARCH) {
    throw new Error(
      "Native harness experiments have been removed. Unset EVALS_NATIVE_HARNESS and EVALS_NATIVE_WEB_SEARCH. See docs/no-guidelines-with-web.md.",
    );
  }

  if (
    experiment &&
    !isWebResearchExperiment(experiment) &&
    experiment !== "no_guidelines" &&
    experiment !== "agents_md"
  ) {
    throw new Error(
      `Unsupported EVALS_EXPERIMENT: ${experiment}. See docs/no-guidelines-with-web.md for the shared web experiment.`,
    );
  }

  if (isWebResearchExperiment(experiment) && env.CUSTOM_GUIDELINES_PATH) {
    throw new Error(
      "no_guidelines_with_web does not allow CUSTOM_GUIDELINES_PATH.",
    );
  }
}
