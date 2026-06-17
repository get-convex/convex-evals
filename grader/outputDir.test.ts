import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getLatestOutputProjectDir,
  readOutputFile,
} from "./outputDir.js";

const testRoots: string[] = [];
const previousEnv = {
  CONVEX_PORT: process.env.CONVEX_PORT,
  MODEL_OUTPUT_DIR: process.env.MODEL_OUTPUT_DIR,
  OUTPUT_TEMPDIR: process.env.OUTPUT_TEMPDIR,
};

function makeRoot(name: string): string {
  const root = join(process.cwd(), `.output-dir-test-${name}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  testRoots.push(root);
  return root;
}

afterEach(() => {
  if (previousEnv.CONVEX_PORT === undefined) {
    delete process.env.CONVEX_PORT;
  } else {
    process.env.CONVEX_PORT = previousEnv.CONVEX_PORT;
  }

  if (previousEnv.MODEL_OUTPUT_DIR === undefined) {
    delete process.env.MODEL_OUTPUT_DIR;
  } else {
    process.env.MODEL_OUTPUT_DIR = previousEnv.MODEL_OUTPUT_DIR;
  }

  if (previousEnv.OUTPUT_TEMPDIR === undefined) {
    delete process.env.OUTPUT_TEMPDIR;
  } else {
    process.env.OUTPUT_TEMPDIR = previousEnv.OUTPUT_TEMPDIR;
  }

  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("getLatestOutputProjectDir", () => {
  it("uses MODEL_OUTPUT_DIR when the scorer provides an explicit project path", () => {
    const root = makeRoot("explicit");
    const explicitProjectDir = join(root, "direct-project");
    mkdirSync(join(explicitProjectDir, "convex"), { recursive: true });

    process.env.MODEL_OUTPUT_DIR = explicitProjectDir;
    delete process.env.OUTPUT_TEMPDIR;

    expect(
      getLatestOutputProjectDir("999-proof", "001-model-output-dir"),
    ).toBe(explicitProjectDir);
  });

  it("prefers MODEL_OUTPUT_DIR over OUTPUT_TEMPDIR scan candidates", () => {
    const root = makeRoot("precedence");
    const explicitProjectDir = join(root, "direct-project");
    const scannedProjectDir = join(
      root,
      "scan-root",
      "output",
      "fake-model",
      "999-proof",
      "001-model-output-dir",
    );

    mkdirSync(explicitProjectDir, { recursive: true });
    mkdirSync(scannedProjectDir, { recursive: true });
    writeFileSync(
      join(scannedProjectDir, ".env.local"),
      "CONVEX_URL=http://localhost:12345",
    );

    process.env.CONVEX_PORT = "12345";
    process.env.MODEL_OUTPUT_DIR = explicitProjectDir;
    process.env.OUTPUT_TEMPDIR = join(root, "scan-root");

    expect(
      getLatestOutputProjectDir("999-proof", "001-model-output-dir"),
    ).toBe(explicitProjectDir);
  });
});

describe("readOutputFile", () => {
  it("reads files from MODEL_OUTPUT_DIR", () => {
    const root = makeRoot("read");
    const explicitProjectDir = join(root, "direct-project");
    const sourcePath = join(explicitProjectDir, "convex", "schema.ts");
    mkdirSync(join(explicitProjectDir, "convex"), { recursive: true });
    writeFileSync(sourcePath, "export default {};\n");

    process.env.MODEL_OUTPUT_DIR = explicitProjectDir;
    delete process.env.OUTPUT_TEMPDIR;

    expect(
      readOutputFile("999-proof", "001-model-output-dir", "convex/schema.ts"),
    ).toBe("export default {};\n");
  });
});
