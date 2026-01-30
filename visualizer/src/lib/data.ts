import { createServerFn } from "@tanstack/react-start";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { FileEntry } from "./types";

// Get the project root (one level up from visualizer)
function getProjectRoot(): string {
  return resolve(process.cwd(), "..");
}

export const getTaskContent = createServerFn({ method: "GET" })
  .inputValidator((data: { category: string; evalName: string }) => data)
  .handler(async ({ data }): Promise<string> => {
    const { category, evalName } = data;
    const taskPath = join(
      getProjectRoot(),
      "evals",
      category,
      evalName,
      "TASK.txt",
    );

    if (!existsSync(taskPath)) {
      throw new Error("Task file not found");
    }

    return readFileSync(taskPath, { encoding: "utf-8" });
  });

export const browseDirectory = createServerFn({ method: "GET" })
  .inputValidator((data: { dirPath: string }) => data)
  .handler(async ({ data }): Promise<FileEntry[]> => {
    const { dirPath } = data;

    if (!existsSync(dirPath)) {
      throw new Error("Directory not found");
    }

    const items = readdirSync(dirPath, { withFileTypes: true });
    return items.map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: join(dirPath, item.name),
    }));
  });

export const getFileContent = createServerFn({ method: "GET" })
  .inputValidator((data: { filePath: string }) => data)
  .handler(async ({ data }): Promise<string> => {
    const { filePath } = data;

    if (!existsSync(filePath)) {
      throw new Error("File not found");
    }

    return readFileSync(filePath, { encoding: "utf-8" });
  });

export const getAnswerDirectory = createServerFn({ method: "GET" })
  .inputValidator((data: { category: string; evalName: string }) => data)
  .handler(async ({ data }): Promise<FileEntry[]> => {
    const { category, evalName } = data;
    const answerPath = join(
      getProjectRoot(),
      "evals",
      category,
      evalName,
      "answer",
    );

    if (!existsSync(answerPath)) {
      return [];
    }

    const items = readdirSync(answerPath, { withFileTypes: true });
    return items.map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: join(answerPath, item.name),
    }));
  });
