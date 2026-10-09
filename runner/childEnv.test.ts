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

  it("keeps locale, certificate and registry settings for installs", () => {
    const env = untrustedChildEnv(
      {},
      {
        ...parentEnv,
        LC_MESSAGES: "en_US.UTF-8",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        ALL_PROXY: "socks5://proxy:1080",
        BUN_CONFIG_REGISTRY: "https://registry.example.com",
        npm_config_registry: "https://registry.example.com",
      },
      false,
    );
    expect(env).toMatchObject({
      LC_MESSAGES: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      ALL_PROXY: "socks5://proxy:1080",
      BUN_CONFIG_REGISTRY: "https://registry.example.com",
      npm_config_registry: "https://registry.example.com",
    });
    expect(env.CONVEX_AUTH_TOKEN).toBeUndefined();
  });

  it("matches Windows variable names case-insensitively", () => {
    const env = untrustedChildEnv(
      {},
      {
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        openrouter_api_key: "openrouter-secret",
      },
      true,
    );
    expect(env).toEqual({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });
});
