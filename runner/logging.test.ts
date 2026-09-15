import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
  spyOn,
} from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  sanitizeOutput,
  appendLog,
  appendLogBlock,
  logCmdResults,
  logInfo,
  logFailureDetails,
  logVitestResults,
  runCommandStep,
} from "./logging.js";

describe("failure diagnostics", () => {
  it("prints a bounded tail with the assertion and tolerates a missing log", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-log-"));
    const logPath = join(dir, "run.log");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(
        logPath,
        "old output".repeat(2000) + "\nAssertionError: expected 1, received 2",
      );
      logFailureDetails(logPath);
      expect(output.mock.calls[1][0]).toHaveLength(12_000);
      expect(output.mock.calls[1][0]).toEndWith(
        "AssertionError: expected 1, received 2",
      );
      logFailureDetails(join(dir, "missing.log"));
      expect(output.mock.calls.at(-1)?.[0]).toBe("Grader log unavailable.");
    } finally {
      output.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeOutput", () => {
  it("strips CSI escape sequences", () => {
    expect(sanitizeOutput("\x1B[31mred text\x1B[0m")).toBe("red text");
  });

  it("strips OSC sequences terminated with BEL", () => {
    expect(sanitizeOutput("\x1B]0;title\x07content")).toBe("content");
  });

  it("strips OSC 8 hyperlinks", () => {
    expect(sanitizeOutput("\x1B]8;;https://example.com\x1B\\click here")).toBe(
      "click here",
    );
  });

  it("strips 7-bit C1 escape codes", () => {
    expect(sanitizeOutput("\x1BDsome text")).toBe("some text");
  });

  it("returns plain text unchanged", () => {
    expect(sanitizeOutput("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(sanitizeOutput("")).toBe("");
  });

  it("strips multiple different escape types", () => {
    const input = "\x1B[1mbold\x1B[0m \x1B]0;title\x07 \x1B[34mblue\x1B[0m";
    const result = sanitizeOutput(input);
    expect(result).toBe("bold  blue");
  });
});

describe("appendLog", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logging-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes text with trailing newline", () => {
    const logPath = join(tempDir, "test.log");
    appendLog(logPath, "hello");
    expect(readFileSync(logPath, "utf-8")).toBe("hello\n");
  });

  it("does not double-newline if text already ends with newline", () => {
    const logPath = join(tempDir, "test.log");
    appendLog(logPath, "hello\n");
    expect(readFileSync(logPath, "utf-8")).toBe("hello\n");
  });

  it("appends multiple lines", () => {
    const logPath = join(tempDir, "test.log");
    appendLog(logPath, "line1");
    appendLog(logPath, "line2");
    expect(readFileSync(logPath, "utf-8")).toBe("line1\nline2\n");
  });

  it("sanitizes ANSI codes before writing", () => {
    const logPath = join(tempDir, "test.log");
    appendLog(logPath, "\x1B[31mred\x1B[0m");
    expect(readFileSync(logPath, "utf-8")).toBe("red\n");
  });

  it("silently handles write errors (e.g. invalid path)", () => {
    appendLog("/nonexistent/dir/file.log", "test");
  });
});

describe("appendLogBlock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logging-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes each line with prefix", () => {
    const logPath = join(tempDir, "test.log");
    appendLogBlock(logPath, "step", "line1\nline2\nline3");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toBe("[step] line1\n[step] line2\n[step] line3\n");
  });

  it("does nothing for null content", () => {
    const logPath = join(tempDir, "test.log");
    appendLogBlock(logPath, "step", null);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("logCmdResults", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logging-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs command name and stdout", () => {
    const logPath = join(tempDir, "test.log");
    logCmdResults(logPath, [{ cmd: "npm test", stdout: "all good" }], "cmd");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[cmd] npm test");
    expect(content).toContain("all good");
  });

  it("supports cmdPrefix", () => {
    const logPath = join(tempDir, "test.log");
    logCmdResults(
      logPath,
      [{ cmd: "npm test", stdout: "all good" }],
      "cmd",
      "prefix ",
    );
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[cmd] prefix npm test");
  });
});

describe("logInfo", () => {
  it("always logs messages", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    logInfo("hello");
    expect(spy).toHaveBeenCalledWith("hello");
    spy.mockRestore();
  });
});

describe("logVitestResults", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logging-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs vitest command and output", () => {
    const logPath = join(tempDir, "test.log");
    logVitestResults(logPath, "bun test", "PASS 1 test");
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[cmd] bun test");
    expect(content).toContain("PASS 1 test");
  });
});

describe("runCommandStep", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logging-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns true and logs on success", async () => {
    const logPath = join(tempDir, "test.log");
    const run = jest.fn().mockResolvedValue({
      cmd: "cmd",
      stdout: "ok",
    });
    const result = await runCommandStep(
      logPath,
      async () => [await run()],
      "step",
      "cmd failed",
    );
    expect(result).toEqual({ passed: true });
    expect(readFileSync(logPath, "utf-8")).toContain("ok");
  });

  it("returns false and logs error on exception", async () => {
    const logPath = join(tempDir, "test.log");
    const run = jest.fn().mockRejectedValue(new Error("boom"));
    const result = await runCommandStep(
      logPath,
      async () => [await run()],
      "step",
      "cmd failed",
    );
    expect(result).toEqual({ passed: false, error: "Error: boom" });
    expect(readFileSync(logPath, "utf-8")).toContain("boom");
  });
});
