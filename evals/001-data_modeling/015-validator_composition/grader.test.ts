import { beforeAll, describe, expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import {
  assertValidator,
  expectedShapes,
  inspectValidators,
  type Inspection,
} from "./checks";

describe("native object-validator composition", () => {
  let inspection: Inspection;

  beforeAll(() => {
    const outputDir = getLatestOutputProjectDir(
      "001-data_modeling",
      "015-validator_composition",
    );
    inspection = inspectValidators(outputDir);
  }, 25_000);

  test("the module typechecks", () => {
    expect(inspection.typeErrors).toEqual([]);
  });

  for (const name of Object.keys(expectedShapes) as Array<
    keyof typeof expectedShapes
  >) {
    test(`${name} has the requested shape and provenance`, () => {
      assertValidator(inspection, name);
    });
  }
});
