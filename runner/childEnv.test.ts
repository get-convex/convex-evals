import { describe, expect, it } from "bun:test";
import { untrustedChildEnv } from "./childEnv.js";

const parentEnv = {
  PATH: "/usr/bin",
  HOME: "/home/runner",
  TMPDIR: "/tmp",
  CI: "true",
  OPENROUTER_API_KEY: "openrouter-secret",
  EXA_API_KEY: "exa-secret",
  CONVEX_AUTH_TOKEN: "reporting-secret",
  CONVEX_EVAL_URL: "https://example.convex.cloud",
  GITHUB_TOKEN: "github-secret",
  NODE_OPTIONS: "--require ./anything.js",
};

describe("untrustedChildEnv", () => {
  it("keeps process basics and drops runner credentials", () => {
    expect(untrustedChildEnv({}, parentEnv, false)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      CI: "true",
    });
  });

  it("adds the variables a child genuinely needs", () => {
    const env = untrustedChildEnv(
      { MODEL_OUTPUT_DIR: "/tmp/out", PATH: "/custom/bin" },
      parentEnv,
      false,
    );
    expect(env.MODEL_OUTPUT_DIR).toBe("/tmp/out");
    expect(env.PATH).toBe("/custom/bin");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("matches Windows variable names case-insensitively", () => {
    const env = untrustedChildEnv(
      {},
      {
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        openrouter_api_key: "openrouter-secret",
      },
      true,
    );
    expect(env).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
  });
});
