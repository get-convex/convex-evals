import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BankInventory, LoadedBank } from "./questions.js";

const sourceId = z.string().regex(/^[\w-]+\/[\w-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const decisionBankManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  codingEvalCount: z.number().int().positive(),
  banks: z
    .array(
      z.strictObject({
        sourceEval: sourceId,
        questionIds: z.array(z.string().min(1)).min(1),
        sourceFingerprint: digest,
        bankSha256: digest,
      }),
    )
    .min(1),
  omittedSources: z.array(
    z.strictObject({
      sourceEval: sourceId,
      coverageLimits: z.array(z.unknown()),
      decisions: z.array(
        z.strictObject({ id: z.string(), reason: z.string() }),
      ),
    }),
  ),
});

export interface DecisionDefinition {
  manifestSha256: string;
  sourceEvals: string[];
  questionIds: string[];
  questionCount: number;
}

/** Intentional retirements are coverage limits, not an incomplete run. A
 * committed allowlist prevents deleting a difficult bank from silently turning
 * the remaining subset into a new "full suite". */
export function readDecisionDefinition(
  root: string,
  inventory: BankInventory,
): {
  definition: DecisionDefinition | null;
  errors: string[];
} {
  const file = join(root, "decision-bank.json");
  if (!existsSync(file)) return { definition: null, errors: [] };
  const errors: string[] = [];
  try {
    const text = readFileSync(file, "utf8");
    const manifest = decisionBankManifestSchema.parse(JSON.parse(text));
    const declared = manifest.banks.map((bank) => bank.sourceEval);
    const omitted = manifest.omittedSources.map((source) => source.sourceEval);
    const sourceSet = new Set([...declared, ...omitted]);
    if (sourceSet.size !== declared.length + omitted.length)
      errors.push("Decision coverage has duplicate or overlapping source IDs");
    const actual = [
      ...inventory.banks.map((bank) => bank.sourceEval),
      ...inventory.missing,
    ];
    if (
      manifest.codingEvalCount !== inventory.sourceEvalCount ||
      sourceSet.size !== actual.length ||
      actual.some((source) => !sourceSet.has(source))
    )
      errors.push(
        "Decision coverage does not account for the complete coding suite",
      );
    if (
      declared.length !== inventory.banks.length ||
      inventory.banks.some((bank) => !declared.includes(bank.sourceEval)) ||
      omitted.length !== inventory.missing.length ||
      inventory.missing.some((source) => !omitted.includes(source))
    )
      errors.push("Question banks differ from the reviewed decision coverage");
    for (const expected of manifest.banks) {
      const bank = inventory.banks.find(
        (candidate) => candidate.sourceEval === expected.sourceEval,
      );
      if (!bank) continue;
      const ids = bank.questions.map((question) => question.id).sort();
      if (
        JSON.stringify(ids) !== JSON.stringify([...expected.questionIds].sort())
      )
        errors.push(`Reviewed question IDs changed: ${expected.sourceEval}`);
      if (bank.sourceFingerprint !== expected.sourceFingerprint)
        errors.push(`Reviewed coding source changed: ${expected.sourceEval}`);
      const contents = readFileSync(
        join(root, "evals", expected.sourceEval, "questions.json"),
      );
      if (
        createHash("sha256").update(contents).digest("hex") !==
        expected.bankSha256
      )
        errors.push(
          `Reviewed question content changed: ${expected.sourceEval}`,
        );
    }
    const questionIds = manifest.banks
      .flatMap((bank) =>
        bank.questionIds.map((id) => `${bank.sourceEval}/${id}`),
      )
      .sort();
    return {
      errors,
      definition: {
        manifestSha256: createHash("sha256").update(text).digest("hex"),
        sourceEvals: [...declared].sort(),
        questionIds,
        questionCount: questionIds.length,
      },
    };
  } catch (error) {
    return {
      definition: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function isCompleteDecisionSelection(
  definition: DecisionDefinition | null,
  selected: LoadedBank[],
): boolean {
  if (!definition) return false;
  const ids = selected
    .flatMap((bank) =>
      bank.questions.map((question) => `${bank.sourceEval}/${question.id}`),
    )
    .sort();
  return JSON.stringify(ids) === JSON.stringify(definition.questionIds);
}
