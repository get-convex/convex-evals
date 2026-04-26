import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  ensureConvexTsconfig,
  getTypecheckTargets,
  isInfrastructureStepFailure,
  walkAnswer,
  writeFilesystem,
} from "./scorer.js";

describe("writeFilesystem pattern", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scorer-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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

  it("rejects empty output", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    expect(() => writeFilesystem(projectDir, {})).toThrow(
      "Empty parsed model output",
    );
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
    expect(files).toHaveLength(2);
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

describe("typecheck target selection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "typecheck-target-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prefers the root tsconfig when present", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });
    writeFileSync(join(projectDir, "tsconfig.json"), '{"compilerOptions":{}}');

    expect(getTypecheckTargets(projectDir)).toEqual([
      resolve(join(projectDir, "tsconfig.json")),
    ]);
  });

  it("checks both root and convex tsconfigs when both are present", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });
    writeFileSync(join(projectDir, "tsconfig.json"), '{"compilerOptions":{}}');
    writeFileSync(
      join(projectDir, "convex", "tsconfig.json"),
      '{"compilerOptions":{}}',
    );

    expect(getTypecheckTargets(projectDir)).toEqual([
      resolve(join(projectDir, "tsconfig.json")),
      resolve(join(projectDir, "convex", "tsconfig.json")),
    ]);
  });

  it("falls back to convex/tsconfig.json when root tsconfig is absent", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });
    writeFileSync(
      join(projectDir, "convex", "tsconfig.json"),
      '{"compilerOptions":{}}',
    );

    expect(getTypecheckTargets(projectDir)).toEqual([
      resolve(join(projectDir, "convex", "tsconfig.json")),
    ]);
  });

  it("falls back to the convex directory when no tsconfig exists", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });

    expect(getTypecheckTargets(projectDir)).toEqual([
      resolve(join(projectDir, "convex")),
    ]);
  });
});

describe("Convex tsconfig seeding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "convex-tsconfig-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a default convex tsconfig when missing", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });

    ensureConvexTsconfig(projectDir);

    expect(existsSync(join(projectDir, "convex", "tsconfig.json"))).toBe(true);
    expect(getTypecheckTargets(projectDir)).toEqual([
      resolve(join(projectDir, "convex", "tsconfig.json")),
    ]);
  });

  it("preserves an existing root tsconfig", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "convex"), { recursive: true });
    writeFileSync(join(projectDir, "tsconfig.json"), '{"compilerOptions":{}}');

    ensureConvexTsconfig(projectDir);

    expect(existsSync(join(projectDir, "convex", "tsconfig.json"))).toBe(false);
    expect(readFileSync(join(projectDir, "tsconfig.json"), "utf-8")).toBe(
      '{"compilerOptions":{}}',
    );
  });
});

describe("infrastructure step classification", () => {
  it("treats install timeouts as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "install",
        "Error: bun install timed out after 60s",
      ),
    ).toBe(true);
  });

  it("does not treat package resolution errors as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "install",
        "Error: Failed to install dependencies:\nerror: package \"not-a-real-package\" not found",
      ),
    ).toBe(false);
  });

  it("treats deploy connection failures as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "deploy",
        "Error: Failed to deploy:\nECONNREFUSED localhost:3210",
      ),
    ).toBe(true);
  });

  it("does not treat Convex code deploy errors as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "deploy",
        "Error: Failed to deploy:\nFailed to push deployment config:\nconvex/schema.ts: Table definition is invalid",
      ),
    ).toBe(false);
  });

  it("treats rate limits as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "install",
        "Error: request failed with 429 Too Many Requests",
      ),
    ).toBe(true);
  });

  it("does not treat 429 substrings in port numbers as rate limits", () => {
    expect(
      isInfrastructureStepFailure(
        "deploy",
        "Error: Failed to deploy:\nconvex dev --url http://localhost:54290\nTable definition is invalid",
      ),
    ).toBe(false);
  });

  it("does not treat 429 line numbers as rate limits", () => {
    expect(
      isInfrastructureStepFailure(
        "deploy",
        "Error: Failed to deploy:\nconvex/schema.ts:429: unexpected token",
      ),
    ).toBe(false);
  });

  it("treats tsc timeouts as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "tsc",
        "Error: tsc (/tmp/project/tsconfig.json) timed out after 60s",
      ),
    ).toBe(true);
  });

  it("does not treat TS5057 tsconfig failures as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "tsc",
        "Error: Failed to typecheck code:\nerror TS5057: Cannot find a tsconfig.json file at the specified directory",
      ),
    ).toBe(false);
  });

  it("does not treat ordinary tsc errors as infrastructure failures", () => {
    expect(
      isInfrastructureStepFailure(
        "tsc",
        "Error: Failed to typecheck code:\nconvex/schema.ts(4,1): error TS1005: ',' expected.",
      ),
    ).toBe(false);
  });
});

describe("ScoreResult structure", () => {
  it("has the expected shape", () => {
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
