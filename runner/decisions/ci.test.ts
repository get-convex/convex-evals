import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DECISION_CI_MODELS } from "./ci.js";

// decision_evals.yml repeats the DECISION_CI_MODELS keys in the model input's
// options and in the JSON array that the "all" option expands to.
type DecisionWorkflow = {
  on: { workflow_dispatch: { inputs: { model: { options: string[] } } } };
  jobs: { decisions: { strategy: { matrix: { model: string } } } };
};

const workflow = Bun.YAML.parse(
  readFileSync(
    resolve(import.meta.dir, "../../.github/workflows/decision_evals.yml"),
    "utf8",
  ),
) as DecisionWorkflow;
const ciKeys = Object.keys(DECISION_CI_MODELS);

// Dispatch options that are not model keys.
const sentinelOptions = new Set(["all", "none"]);

function describeDrift(listName: string, listed: string[]): string[] {
  return [
    ...ciKeys
      .filter((key) => !listed.includes(key))
      .map(
        (key) => `${key} is in DECISION_CI_MODELS but missing from ${listName}`,
      ),
    ...listed
      .filter((key) => !ciKeys.includes(key))
      .map(
        (key) => `${key} is in ${listName} but missing from DECISION_CI_MODELS`,
      ),
  ];
}

describe("decision_evals.yml model lists", () => {
  it("offers every DECISION_CI_MODELS key as a model option", () => {
    const options = workflow.on.workflow_dispatch.inputs.model.options.filter(
      (option) => !sentinelOptions.has(option),
    );
    expect(describeDrift("the model input's options", options)).toEqual([]);
    expect(options).toEqual(ciKeys);
  });

  it("runs every DECISION_CI_MODELS key when model is all", () => {
    const expression = workflow.jobs.decisions.strategy.matrix.model;
    const match = /inputs\.model\s*==\s*'all'\s*&&\s*'(\[[^']*\])'/.exec(
      expression,
    );
    if (!match) {
      throw new Error(
        `No "all" JSON array in the matrix expression: ${expression}`,
      );
    }

    const allMatrix = JSON.parse(match[1]) as string[];
    expect(describeDrift("the all matrix array", allMatrix)).toEqual([]);
    expect(allMatrix).toEqual(ciKeys);
  });
});
