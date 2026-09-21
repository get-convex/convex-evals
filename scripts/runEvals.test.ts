import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { buildEnvVars } from "./runEvals";
import { runEvalsForModel } from "../runner/index";

const previous = { ...process.env };
afterEach(() => {
  process.env = { ...previous };
});

test("selecting web supplies a safe child environment that passes runner validation", async () => {
  const parent = {
    OPENROUTER_API_KEY: "fixture",
    EXA_API_KEY: "fixture",
    DISABLE_CONVEX_REPORTING: "0",
  };
  const env = buildEnvVars(
    {
      models: ["fixture"],
      experiment: "no_guidelines_with_web",
      filter: "003-crons",
      outputTempdir: "unused",
    },
    parent,
  );
  expect(env.CLIENT_WEB_TOOLS).toBe("1");
  expect(env.DISABLE_CONVEX_REPORTING).toBe("1");
  expect(env.MODELS).toBe("fixture");
  expect(env.TEST_FILTER).toBe("003-crons");
  expect(env.OUTPUT_TEMPDIR).toBe("unused");
  expect(parent.DISABLE_CONVEX_REPORTING).toBe("0");
  process.env = env;
  // Stop at model access: prove the real runner accepts the launcher's flags
  // without running models, starting a backend, or reporting anything.
  await rejects(
    runEvalsForModel({
      experiment: env.EVALS_EXPERIMENT,
      get model(): never {
        throw new Error("reached-model-after-validation");
      },
      tempdir: "unused",
    }),
    /reached-model-after-validation/,
  );
});

test.each([undefined, "no_guidelines"] as const)(
  "switching from inherited web flags to %s clears stale tool state",
  (experiment) => {
    const env = buildEnvVars(
      { models: [], experiment },
      {
        EVALS_EXPERIMENT: "no_guidelines_with_web",
        CLIENT_WEB_TOOLS: "1",
        DISABLE_CONVEX_REPORTING: "1",
      },
    );
    expect(env.EVALS_EXPERIMENT).toBe(experiment);
    expect(env.CLIENT_WEB_TOOLS).toBeUndefined();
    expect(env.DISABLE_CONVEX_REPORTING).toBe("1");
  },
);

test("web selection still gives an actionable missing-key error", async () => {
  process.env = buildEnvVars(
    { models: [], experiment: "no_guidelines_with_web" },
    { OPENROUTER_API_KEY: "fixture" },
  );
  await rejects(
    runEvalsForModel({
      experiment: process.env.EVALS_EXPERIMENT,
      get model(): never {
        throw new Error("model accessed before key validation");
      },
      tempdir: "unused",
    }),
    /EXA_API_KEY is required/,
  );
});
