import { describe, expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import {
  assertValidator,
  expectedShapes,
  inspectValidators,
  type Inspection,
} from "./checks";

describe("native object-validator composition", () => {
  let outcome: { value: Inspection } | { error: unknown } | undefined;

  function inspection(): Inspection {
    // Candidate execution belongs to an assertion, not a setup hook. A broken
    // module should fail these tests, rather than skip the suite as a grader
    // setup failure. Cache errors too so a timeout runs only once.
    if (!outcome) {
      try {
        const outputDir = getLatestOutputProjectDir(
          "001-data_modeling",
          "015-validator_composition",
        );
        outcome = { value: inspectValidators(outputDir) };
      } catch (error) {
        outcome = { error };
      }
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  test("the module typechecks", () => {
    expect(inspection().typeErrors).toEqual([]);
  }, 25_000);

  for (const name of Object.keys(expectedShapes) as Array<
    keyof typeof expectedShapes
  >) {
    test(`${name} has the requested shape and provenance`, () => {
      assertValidator(inspection(), name);
    }, 25_000);
  }
});
