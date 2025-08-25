/* eslint-disable */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

type EvalInfo = {
  category: string;
  name: string;
  testFilePath: string;
};

type GradeResult = {
  result: "pass" | "fail";
  reasoning: string;
};

/**
 * Extract eval category and name from the test file URL and load the task content.
 */
function getTask(testFileUrl: string): {
  evalInfo: EvalInfo;
  taskContent: string;
} {
  const testFilePath = fileURLToPath(testFileUrl);
  const parts = testFilePath.replace(/\\/g, "/").split("/");
  const evalsIdx = parts.lastIndexOf("evals");
  if (evalsIdx < 0 || parts.length < evalsIdx + 3)
    throw new Error(
      `Could not derive eval category/name from path: ${testFilePath}`,
    );

  const evalInfo: EvalInfo = {
    category: parts[evalsIdx + 1],
    name: parts[evalsIdx + 2],
    testFilePath,
  };

  // Load the task assignment alongside the grader
  const taskPath = testFilePath
    .replace(/grader\.test\.ts$/, "TASK.txt")
    .replace(/grader\.test\.tsx$/, "TASK.txt");

  let taskContent = "";
  try {
    taskContent = readFileSync(taskPath, { encoding: "utf-8" });
  } catch {
    throw new Error(`TASK.txt not found at expected path: ${taskPath}`);
  }

  return { evalInfo, taskContent };
}

/**
 * Find and return paths to all answer files in the generated output directory.
 */
function gatherAnswerFiles(evalInfo: EvalInfo): {
  filePaths: string[];
  outputProjectDir: string;
} {
  const { category, name } = evalInfo;

  // Locate the generated output project directory under the system tempdir
  const candidateRoots = [] as { dir: string; mtime: number }[];
  const tdir = tmpdir();

  for (const entry of readdirSync(tdir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(tdir, entry.name, "output");
    try {
      const models = readdirSync(root, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      for (const modelDir of models) {
        const projectDir = join(root, modelDir.name, category, name);
        try {
          const st = statSync(projectDir);
          if (st.isDirectory())
            candidateRoots.push({ dir: projectDir, mtime: st.mtimeMs });
        } catch {
          // ignore missing
        }
      }
    } catch {
      // no output here
    }
  }

  if (candidateRoots.length === 0)
    throw new Error(
      `Could not find output directory for ${category}/${name} under ${tdir}`,
    );

  candidateRoots.sort((a, b) => b.mtime - a.mtime);
  const outputProjectDir = candidateRoots[0].dir;

  // Collect file paths with exclusions
  const excludedFileNames = new Set([
    "run.log",
    "tsconfig.json",
    "bun.lock",
    ".env.local",
  ]);
  const shouldInclude = (fullPath: string): boolean => {
    const rel = relative(outputProjectDir, fullPath).replace(/\\/g, "/");
    if (rel.startsWith("node_modules/")) return false;
    if (rel.startsWith("convex/_generated/")) return false;
    if (rel === "convex/README.md") return false;
    if (rel === "convex/tsconfig.json") return false;
    const base = rel.split("/").pop() ?? "";
    if (excludedFileNames.has(base)) return false;
    return true;
  };

  const stack: string[] = [outputProjectDir];
  const filePaths: string[] = [];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const de of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, de.name);
      if (de.isDirectory()) {
        if (de.name === "node_modules") continue;
        if (
          de.name === "_generated" &&
          dir.replace(/\\/g, "/").endsWith("/convex")
        )
          continue;
        stack.push(full);
      } else {
        if (shouldInclude(full)) filePaths.push(full);
      }
    }
  }

  filePaths.sort();
  return { filePaths, outputProjectDir };
}

/**
 * Read and concatenate all answer files into a single string with file headers.
 */
function concatenateAnswerFiles(
  filePaths: string[],
  outputProjectDir: string,
): string {
  if (filePaths.length === 0) return "";

  let concatenated = "";

  for (const fp of filePaths) {
    try {
      const rel = relative(outputProjectDir, fp).replace(/\\/g, "/");
      const content = readFileSync(fp, { encoding: "utf-8" });
      concatenated += `\n\n===== FILE: ${rel} =====\n`;
      concatenated += content;
    } catch {
      // skip unreadable files
    }
  }

  if (concatenated.length > 300_000)
    concatenated = concatenated.slice(0, 300_000) + "\n\n... [truncated]";

  return concatenated;
}

/**
 * Use AI to generate a grade based on the task and concatenated files.
 */
async function generateGrade(
  taskContent: string,
  concatenated: string,
): Promise<GradeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const prompt = `You are grading an autogenerated Convex backend submission.\n\nTask assignment (verbatim from TASK.txt):\n---\n${taskContent}\n---\n\nGenerated output files (concatenated with headers):\n---\n${concatenated}\n---\n\nDecide if the output fully satisfies the task requirements. Provide a short reasoning and a final grade.`;

  const openai = createOpenAI({ apiKey });

  const schema = z.object({
    grade: z.enum(["pass", "fail"]),
    reasoning: z.string().min(1).max(500),
  });

  const resultObj = schema.parse(
    (
      await generateObject({
        model: openai("gpt-5-mini"),
        schema,
        prompt,
      })
    ).object,
  );

  return { result: resultObj.grade, reasoning: resultObj.reasoning };
}

/**
 * Grade the generated output for the current eval using an AI model.
 *
 * Usage from a grader test file:
 *   const passed = await aiGradeGeneratedOutput(import.meta.url)
 *
 * Returns true for pass, false for fail. Logs model reasoning to console.
 */
export async function aiGradeGeneratedOutput(
  testFileUrl: string,
): Promise<"pass" | "fail"> {
  const { evalInfo, taskContent } = getTask(testFileUrl);
  const { filePaths, outputProjectDir } = gatherAnswerFiles(evalInfo);
  const concatenated = concatenateAnswerFiles(filePaths, outputProjectDir);
  const { result, reasoning } = await generateGrade(taskContent, concatenated);

  // Log concise reasoning for visibility
  console.log(
    `[AI Grader ${evalInfo.category}/${evalInfo.name}] ${result == "pass" ? "PASS" : "FAIL"}: ${reasoning}`,
  );

  return result;
}
