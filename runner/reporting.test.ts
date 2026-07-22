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
import { canReportEvalResultsTo } from "./reporting.js";

describe("production reporting boundary", () => {
  const productionUrl = "https://fabulous-panther-525.convex.cloud";

  it("rejects production reporting from a local process", () => {
    expect(canReportEvalResultsTo(productionUrl, {})).toBe(false);
    expect(canReportEvalResultsTo(`${productionUrl}/`, {})).toBe(false);
  });

  it("allows production reporting only from GitHub Actions on main", () => {
    expect(
      canReportEvalResultsTo(productionUrl, {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
      }),
    ).toBe(true);
    expect(
      canReportEvalResultsTo(productionUrl, {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/feature",
      }),
    ).toBe(false);
  });

  it("allows local reporting to non-production deployments", () => {
    expect(
      canReportEvalResultsTo("https://brazen-pelican-414.convex.cloud", {}),
    ).toBe(true);
  });
});

describe("zip creation with JSZip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reporting-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a valid zip file from directory contents", async () => {
    const srcDir = join(tempDir, "project");
    mkdirSync(join(srcDir, "convex"), { recursive: true });
    writeFileSync(join(srcDir, "package.json"), '{"name":"test"}');
    writeFileSync(join(srcDir, "convex", "schema.ts"), "export default {};");

    const zip = new JSZip();
    zip.file("package.json", readFileSync(join(srcDir, "package.json")));
    zip.file(
      "convex/schema.ts",
      readFileSync(join(srcDir, "convex", "schema.ts")),
    );

    const content = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = join(tempDir, "test.zip");
    writeFileSync(zipPath, content);

    const readZip = await JSZip.loadAsync(readFileSync(zipPath));
    const files = Object.keys(readZip.files);
    expect(files).toContain("package.json");
    expect(files).toContain("convex/schema.ts");

    const pkgContent = await readZip.file("package.json")!.async("string");
    expect(pkgContent).toBe('{"name":"test"}');
  });

  it("uses forward slashes in zip entries regardless of OS", async () => {
    const zip = new JSZip();
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
    expect(content.length).toBeGreaterThan(0);
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
    const zip = new JSZip();
    const fileContent = "#!/bin/bash\necho hello";
    zip.file("convex-local-backend", fileContent);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);
    const entry = loadedZip.file("convex-local-backend");
    expect(entry).not.toBeNull();

    const extracted = await entry!.async("nodebuffer");
    const outputPath = join(tempDir, "convex-local-backend");
    writeFileSync(outputPath, extracted);

    expect(readFileSync(outputPath, "utf-8")).toBe(fileContent);
  });

  it("throws clear error when expected file is not in zip", async () => {
    const zip = new JSZip();
    zip.file("something-else", "data");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);
    expect(loadedZip.file("convex-local-backend")).toBeNull();
  });

  it("extracts a .exe file from a zip", async () => {
    const zip = new JSZip();
    zip.file("convex-local-backend.exe", "winbin");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);
    const entry = loadedZip.file("convex-local-backend.exe");
    expect(entry).not.toBeNull();
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

  function hashFiles(paths: string[]): string {
    const h = createHash("sha256");
    for (const p of paths) {
      h.update(p);
      h.update("\0");
      h.update(readFileSync(p));
      h.update("\0");
    }
    return h.digest("hex");
  }

  it("produces consistent hashes for the same content", () => {
    const a = join(tempDir, "a.txt");
    const b = join(tempDir, "b.txt");
    writeFileSync(a, "hello");
    writeFileSync(b, "world");
    const first = hashFiles([a, b]);
    const second = hashFiles([a, b]);
    expect(first).toBe(second);
  });

  it("produces different hashes for different content", () => {
    const a = join(tempDir, "a.txt");
    const b = join(tempDir, "b.txt");
    writeFileSync(a, "hello");
    writeFileSync(b, "world");
    const first = hashFiles([a, b]);
    writeFileSync(b, "changed");
    const second = hashFiles([a, b]);
    expect(first).not.toBe(second);
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
    const output = join(tempDir, "out.jsonl");
    appendFileSync(output, `${JSON.stringify({ a: 1 })}\n`);
    appendFileSync(output, `${JSON.stringify({ b: 2 })}\n`);
    const lines = readFileSync(output, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ b: 2 });
    expect(existsSync(output)).toBe(true);
  });
});
