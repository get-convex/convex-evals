/**
 * Environment for child processes that install, deploy, typecheck, lint or
 * grade model-generated projects. Those processes run model-written code
 * (package scripts, Convex functions, model-authored tests), so they get only
 * what is needed to find executables, caches, temp space, certificates and
 * package registries. The runner's OpenRouter, Exa, reporting and GitHub
 * credentials are not passed on.
 *
 * This is a stripped environment, not a security sandbox. Model code still
 * runs as the same OS user as the runner, so it can read anything that user
 * can, such as a local `.env` file or, on Linux, the start-up environment of
 * other same-user processes under /proc.
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
  // Locale and non-interactive behaviour. LC_* is matched by prefix below.
  "LANG",
  "TZ",
  "CI",
  // Proxies, extra CA certificates and registry mirrors for dependency
  // installs, so machines behind a TLS-intercepting proxy or using a mirror
  // can still install.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BUN_CONFIG_REGISTRY",
  "NPM_CONFIG_REGISTRY",
  "npm_config_registry",
  // Windows process basics.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

const INHERITED_ENV_PREFIXES = ["LC_"];

/**
 * Build a child environment from the allowlisted parent variables plus
 * `extra`. Windows variable names are case-insensitive, so match them that way.
 */
export function untrustedChildEnv(
  extra: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = process.env,
  windows = platform() === "win32",
): Record<string, string> {
  const normalize = (name: string): string =>
    windows ? name.toUpperCase() : name;
  const allowed = new Set(INHERITED_ENV_VARS.map(normalize));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const key = normalize(name);
    if (
      allowed.has(key) ||
      INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}
