/**
 * Environment for child processes that install, deploy, typecheck, lint or
 * grade model-generated projects. Those processes run model-written code
 * (package scripts, Convex functions, model-authored tests), so they get only
 * what is needed to find executables, caches and temp space. The runner's
 * OpenRouter, Exa, reporting and GitHub credentials stay in the runner.
 */
import { platform } from "os";

const INHERITED_ENV_VARS = [
  // Executables, package caches and temp space.
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  // Locale and non-interactive behaviour.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  // Proxies for dependency installs.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows process basics.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * Build a child environment from the allowlisted parent variables plus
 * `extra`. Windows variable names are case-insensitive, so match them that way.
 */
export function untrustedChildEnv(
  extra: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = process.env,
  windows = platform() === "win32",
): Record<string, string> {
  const allowed = new Set(
    windows
      ? INHERITED_ENV_VARS.map((name) => name.toUpperCase())
      : INHERITED_ENV_VARS,
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (allowed.has(windows ? name.toUpperCase() : name)) env[name] = value;
  }
  return { ...env, ...extra };
}
