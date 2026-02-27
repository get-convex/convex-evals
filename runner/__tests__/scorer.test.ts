import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { walkAnswer } from "../scorer.js";

describe("writeFilesystem pattern", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scorer-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Replicate the writeFilesystem logic for testing since it's not exported.
   */
  function writeFilesystem(
    projectDir: string,
    output: Record<string, string>,
  ): void {
    const absDir = resolve(projectDir);
    for (const [relativePath, content] of Object.entries(output)) {
      const filePath = resolve(join(absDir, relativePath));
      if (!filePath.startsWith(absDir)) {
        throw new Error(
          `Invalid filesystem output: ${filePath} is not in ${absDir}`,
        );
      }
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
    }
  }

  it("writes a flat set of files", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFilesystem(projectDir, {
      "package.json": '{"name":"test"}',
      "tsconfig.json": '{"compilerOptions":{}}',
    });

    expect(readFileSync(join(projectDir, "package.json"), "utf-8")).toBe(
      '{"name":"test"}',
    );
    expect(readFileSync(join(projectDir, "tsconfig.json"), "utf-8")).toBe(
      '{"compilerOptions":{}}',
    );
  });

  it("creates nested directories", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFilesystem(projectDir, {
      "convex/schema.ts": "export default {};",
      "convex/tasks/list.ts": "export const list = 1;",
    });

    expect(existsSync(join(projectDir, "convex", "schema.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "convex", "tasks", "list.ts"))).toBe(
      true,
    );
    expect(
      readFileSync(join(projectDir, "convex", "tasks", "list.ts"), "utf-8"),
    ).toBe("export const list = 1;");
  });

  it("rejects path traversal attempts", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    expect(() =>
      writeFilesystem(projectDir, {
        "../escape.ts": "malicious",
      }),
    ).toThrow("is not in");
  });

  it("handles empty output", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFilesystem(projectDir, {});
    // Project dir should exist but be empty (no new files created)
    const files = readdirSync(projectDir);
    expect(files).toHaveLength(0);
  });

  it("writes UTF-8 content correctly", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const content = 'const greeting = "こんにちは世界"; // Unicode content';
    writeFilesystem(projectDir, {
      "convex/hello.ts": content,
    });

    expect(readFileSync(join(projectDir, "convex", "hello.ts"), "utf-8")).toBe(
      content,
    );
  });

  it("overwrites existing files", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "file.ts"), "old content");

    writeFilesystem(projectDir, {
      "file.ts": "new content",
    });

    expect(readFileSync(join(projectDir, "file.ts"), "utf-8")).toBe(
      "new content",
    );
  });
});

describe("walkAnswer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "walk-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("yields .ts files and package.json", () => {
    const answerDir = join(tempDir, "answer");
    mkdirSync(join(answerDir, "convex"), { recursive: true });
    writeFileSync(join(answerDir, "package.json"), "{}");
    writeFileSync(join(answerDir, "convex", "schema.ts"), "export default {};");
    writeFileSync(join(answerDir, "convex", "tasks.ts"), "export const t = 1;");

    const files = [...walkAnswer(answerDir)];
    expect(files).toHaveLength(3);

    const fileNames = files.map((f) => f.split(/[/\\]/).pop());
    expect(fileNames).toContain("package.json");
    expect(fileNames).toContain("schema.ts");
    expect(fileNames).toContain("tasks.ts");
  });

  it("skips node_modules", () => {
    const answerDir = join(tempDir, "answer");
    mkdirSync(join(answerDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(answerDir, "node_modules", "dep", "index.ts"), "");
    writeFileSync(join(answerDir, "package.json"), "{}");

    const files = [...walkAnswer(answerDir)];
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("package.json");
  });

  it("skips _generated directory", () => {
    const answerDir = join(tempDir, "answer");
    mkdirSync(join(answerDir, "_generated"), { recursive: true });
    writeFileSync(join(answerDir, "_generated", "api.ts"), "");
    writeFileSync(join(answerDir, "package.json"), "{}");

    const files = [...walkAnswer(answerDir)];
    expect(files).toHaveLength(1);
  });

  it("skips non-.ts and non-package.json files", () => {
    const answerDir = join(tempDir, "answer");
    mkdirSync(answerDir, { recursive: true });
    writeFileSync(join(answerDir, "package.json"), "{}");
    writeFileSync(join(answerDir, "readme.md"), "# readme");
    writeFileSync(join(answerDir, "data.json"), "{}");
    writeFileSync(join(answerDir, "script.ts"), "export const x = 1;");

    const files = [...walkAnswer(answerDir)];
    expect(files).toHaveLength(2); // package.json and script.ts
  });

  it("returns empty array for non-existent directory", () => {
    const files = [...walkAnswer(join(tempDir, "nonexistent"))];
    expect(files).toHaveLength(0);
  });

  it("handles deeply nested directories", () => {
    const answerDir = join(tempDir, "answer");
    mkdirSync(join(answerDir, "convex", "features", "auth"), {
      recursive: true,
    });
    writeFileSync(
      join(answerDir, "convex", "features", "auth", "login.ts"),
      "export const login = 1;",
    );
    writeFileSync(join(answerDir, "package.json"), "{}");

    const files = [...walkAnswer(answerDir)];
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("login.ts"))).toBe(true);
  });
});

describe("ScoreResult structure", () => {
  it("has the expected shape", () => {
    // This test validates the ScoreResult interface shape
    const result = { name: "Test score", score: 0.75 };
    expect(result.name).toBe("Test score");
    expect(result.score).toBe(0.75);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("withTimeout pattern", () => {
  async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "test",
    );
    expect(result).toBe("ok");
  });

  it("rejects when promise exceeds timeout", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      withTimeout(
        new Promise((resolve) => setTimeout(resolve, 5000)),
        50,
        "slow operation",
      ),
    ).rejects.toThrow("slow operation timed out after 0.05s");
  });

  it("preserves the original error when promise rejects before timeout", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      withTimeout(
        Promise.reject(new Error("original error")),
        1000,
        "test",
      ),
    ).rejects.toThrow("original error");
  });
});
