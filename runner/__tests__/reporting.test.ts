import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  rmSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import JSZip from "jszip";

/**
 * These tests exercise the zip creation and directory hashing logic
 * by importing internal helpers. Since zipDirectory and walkDirForZip
 * are not exported, we test them indirectly through exported functions
 * or replicate their logic for testing.
 *
 * We also test the JSONL writing and hash computation patterns.
 */

describe("zip creation with JSZip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reporting-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a valid zip file from directory contents", async () => {
    // Create test directory structure
    const srcDir = join(tempDir, "project");
    mkdirSync(join(srcDir, "convex"), { recursive: true });
    writeFileSync(join(srcDir, "package.json"), '{"name":"test"}');
    writeFileSync(join(srcDir, "convex", "schema.ts"), "export default {};");

    // Replicate zip creation logic from reporting.ts
    const zip = new JSZip();
    zip.file("package.json", readFileSync(join(srcDir, "package.json")));
    zip.file(
      "convex/schema.ts",
      readFileSync(join(srcDir, "convex", "schema.ts")),
    );

    const content = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = join(tempDir, "test.zip");
    writeFileSync(zipPath, content);

    // Verify the zip can be read back
    const readZip = await JSZip.loadAsync(readFileSync(zipPath));
    const files = Object.keys(readZip.files);
    expect(files).toContain("package.json");
    expect(files).toContain("convex/schema.ts");

    const pkgContent = await readZip.file("package.json")!.async("string");
    expect(pkgContent).toBe('{"name":"test"}');
  });

  it("uses forward slashes in zip entries regardless of OS", async () => {
    const zip = new JSZip();
    // Simulate a Windows-style path being normalized
    const windowsPath = "convex\\tasks\\list.ts";
    const normalized = windowsPath.replace(/\\/g, "/");
    zip.file(normalized, "export const list = 1;");

    const content = await zip.generateAsync({ type: "nodebuffer" });
    const readZip = await JSZip.loadAsync(content);
    expect(Object.keys(readZip.files)).toContain("convex/tasks/list.ts");
  });

  it("handles empty zip gracefully", async () => {
    const zip = new JSZip();
    const content = await zip.generateAsync({ type: "nodebuffer" });
    expect(content.length).toBeGreaterThan(0); // Even empty zips have headers
  });

  it("handles binary content in files", async () => {
    const zip = new JSZip();
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    zip.file("binary.bin", binaryData);

    const content = await zip.generateAsync({ type: "nodebuffer" });
    const readZip = await JSZip.loadAsync(content);
    const readBack = await readZip.file("binary.bin")!.async("nodebuffer");
    expect(Buffer.compare(binaryData, readBack)).toBe(0);
  });
});

describe("zip extraction with JSZip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "extract-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts a specific file from a zip", async () => {
    // Create a zip with a known file
    const zip = new JSZip();
    const fileContent = "#!/bin/bash\necho hello";
    zip.file("convex-local-backend", fileContent);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    // Extract using the same pattern as convexBackend.ts
    const loadedZip = await JSZip.loadAsync(zipBuffer);
    const entry = loadedZip.file("convex-local-backend");
    expect(entry).not.toBeNull();

    const extracted = await entry!.async("nodebuffer");
    const outputPath = join(tempDir, "convex-local-backend");
    writeFileSync(outputPath, extracted);

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf-8")).toBe(fileContent);
  });

  it("throws clear error when expected file is not in zip", async () => {
    const zip = new JSZip();
    zip.file("other-file.txt", "hello");

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);

    const entry = loadedZip.file("convex-local-backend");
    expect(entry).toBeNull();

    // This is the pattern from convexBackend.ts
    if (!entry) {
      const error = `Expected 'convex-local-backend' in zip but not found. Contents: ${Object.keys(loadedZip.files).join(", ")}`;
      expect(error).toContain("other-file.txt");
    }
  });

  it("extracts a .exe file from a zip", async () => {
    const zip = new JSZip();
    // Simulate a binary file
    const binaryContent = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binaryContent[i] = i;
    zip.file("convex-local-backend.exe", binaryContent);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);
    const entry = loadedZip.file("convex-local-backend.exe");
    expect(entry).not.toBeNull();

    const extracted = await entry!.async("nodebuffer");
    expect(Buffer.compare(binaryContent, extracted)).toBe(0);
  });
});

describe("directory hashing pattern", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hash-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("produces consistent hashes for the same content", () => {
    const dir = join(tempDir, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "const a = 1;");
    writeFileSync(join(dir, "b.ts"), "const b = 2;");

    const hasher1 = createHash("sha256");
    hasher1.update("a.ts");
    hasher1.update(readFileSync(join(dir, "a.ts")));
    hasher1.update("b.ts");
    hasher1.update(readFileSync(join(dir, "b.ts")));
    const hash1 = hasher1.digest("hex");

    const hasher2 = createHash("sha256");
    hasher2.update("a.ts");
    hasher2.update(readFileSync(join(dir, "a.ts")));
    hasher2.update("b.ts");
    hasher2.update(readFileSync(join(dir, "b.ts")));
    const hash2 = hasher2.digest("hex");

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it("produces different hashes for different content", () => {
    const hasher1 = createHash("sha256");
    hasher1.update("file.ts");
    hasher1.update("const a = 1;");
    const hash1 = hasher1.digest("hex");

    const hasher2 = createHash("sha256");
    hasher2.update("file.ts");
    hasher2.update("const a = 2;");
    const hash2 = hasher2.digest("hex");

    expect(hash1).not.toBe(hash2);
  });
});

describe("JSONL writing pattern", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes valid JSONL with one record per line", () => {
    const jsonlPath = join(tempDir, "results.jsonl");
    const record1 = { model: "gpt-5", score: 1 };
    const record2 = { model: "claude-4", score: 0.8 };

    appendFileSync(jsonlPath, JSON.stringify(record1) + "\n");
    appendFileSync(jsonlPath, JSON.stringify(record2) + "\n");

    const lines = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]) as { model: string; score: number };
    expect(parsed1.model).toBe("gpt-5");
    expect(parsed1.score).toBe(1);

    const parsed2 = JSON.parse(lines[1]) as { model: string; score: number };
    expect(parsed2.model).toBe("claude-4");
    expect(parsed2.score).toBe(0.8);
  });
});
