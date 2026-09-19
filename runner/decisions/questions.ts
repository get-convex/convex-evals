import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  discoverBenchmarkEvalPaths,
  isBenchmarkRuntimeArtifact,
} from "../benchmark.js";
import { DECISION_PROTOCOL } from "./protocol.js";

const nonempty = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const optionSchema = z.strictObject({
  id: identifier,
  text: nonempty,
  rationale: nonempty,
});
const questionSchema = z
  .strictObject({
    id: identifier,
    concept: nonempty,
    context: z.string(),
    question: nonempty,
    options: z.array(optionSchema).length(4),
    correctOptionId: identifier,
    sourceReferences: z.array(nonempty).min(1),
  })
  .superRefine((question, ctx) => {
    if (new Set(question.options.map((option) => option.id)).size !== 4) {
      ctx.addIssue({ code: "custom", message: "Option IDs must be unique" });
    }
    if (
      new Set(question.options.map((option) => option.text.trim())).size !== 4
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Option texts must be distinct",
      });
    }
    if (
      !question.options.some((option) => option.id === question.correctOptionId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Answer key does not name an option",
      });
    }
  });
export const questionBankSchema = z
  .strictObject({
    version: z.literal(1),
    sourceEval: z.string().regex(/^[\w-]+\/[\w-]+$/),
    coverageNotes: nonempty,
    questions: z.array(questionSchema).min(1).max(4),
  })
  .superRefine((bank, ctx) => {
    if (
      new Set(bank.questions.map((question) => question.id)).size !==
      bank.questions.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Question IDs must be unique within an eval",
      });
    }
  });

export type DecisionQuestion = z.infer<typeof questionSchema>;
export type QuestionBank = z.infer<typeof questionBankSchema>;
export interface LoadedBank extends QuestionBank {
  sourceFingerprint: string;
}
export interface BankInventory {
  sourceEvalCount: number;
  questionCount: number;
  banks: LoadedBank[];
  missing: string[];
  errors: string[];
}

/** Record provenance without a circular dependency on the new question file. */
export function sourceFingerprint(directory: string): string {
  const hash = createHash("sha256");
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        [
          "questions.json",
          "node_modules",
          "_generated",
          "__pycache__",
          "backend",
        ].includes(entry.name)
      )
        continue;
      if (entry.isFile() && isBenchmarkRuntimeArtifact(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        hash
          .update(relative(directory, full))
          .update("\0")
          .update(readFileSync(full))
          .update("\0");
    }
  };
  walk(directory);
  return hash.digest("hex");
}

export function loadQuestionBanks(projectRoot = process.cwd()): BankInventory {
  const paths = discoverBenchmarkEvalPaths(projectRoot);
  const result: BankInventory = {
    sourceEvalCount: paths.length,
    questionCount: 0,
    banks: [],
    missing: [],
    errors: [],
  };
  for (const evalPath of paths) {
    const sourceEval = evalPath.replace(/^evals\//, "");
    const directory = join(projectRoot, evalPath);
    const file = join(directory, "questions.json");
    if (!existsSync(file)) {
      result.missing.push(sourceEval);
      continue;
    }
    try {
      const bank = questionBankSchema.parse(
        JSON.parse(readFileSync(file, "utf8")),
      );
      if (bank.sourceEval !== sourceEval)
        throw new Error(`sourceEval must be ${sourceEval}`);
      for (const question of bank.questions) {
        for (const reference of question.sourceReferences) {
          const referenceRoot = reference.startsWith("docs/")
            ? resolve(projectRoot)
            : resolve(directory);
          const absolute = resolve(referenceRoot, reference);
          if (
            !absolute.startsWith(`${referenceRoot}/`) ||
            !existsSync(absolute)
          ) {
            throw new Error(
              `${question.id}: invalid or missing source reference ${reference}`,
            );
          }
        }
      }
      result.banks.push({
        ...bank,
        sourceFingerprint: sourceFingerprint(directory),
      });
      result.questionCount += bank.questions.length;
    } catch (error) {
      result.errors.push(
        `${sourceEval}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

export interface PresentedQuestion {
  /** Only this object may be projected into a provider request. */
  input: { context: string; question: string; options: Record<string, string> };
  displayToCanonical: Record<string, string>;
  expectedDisplayId: string;
}

export function presentQuestion(
  question: DecisionQuestion,
  sourceEval: string,
  seed: string,
  repetition: number,
): PresentedQuestion {
  const options = [...question.options];
  // Counter-based hash draws are reproducible across providers and runtimes.
  for (let i = options.length - 1; i > 0; i--) {
    const draw = createHash("sha256")
      .update(JSON.stringify([seed, sourceEval, question.id, repetition, i]))
      .digest()
      .readUInt32BE(0);
    const j = draw % (i + 1);
    [options[i], options[j]] = [options[j], options[i]];
  }
  const displayToCanonical: Record<string, string> = {};
  const displayed: Record<string, string> = {};
  let expectedDisplayId = "";
  options.forEach((option, index) => {
    const label = String.fromCharCode(65 + index);
    displayed[label] = option.text;
    displayToCanonical[label] = option.id;
    if (option.id === question.correctOptionId) expectedDisplayId = label;
  });
  return {
    input: {
      context: question.context,
      question: question.question,
      options: displayed,
    },
    displayToCanonical,
    expectedDisplayId,
  };
}

export function buildSharedState(
  presented: PresentedQuestion,
  guidelines: string,
): Record<string, string> {
  return {
    evaluationInstructions: DECISION_PROTOCOL.systemPrompt,
    context: presented.input.context,
    ...(guidelines ? { convexGuidelines: guidelines } : {}),
  };
}
