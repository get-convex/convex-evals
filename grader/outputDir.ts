import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function getExplicitOutputProjectDir(): string | null {
  const explicit = process.env.MODEL_OUTPUT_DIR;
  if (!explicit || !existsSync(explicit)) return null;

  try {
    return statSync(explicit).isDirectory() ? explicit : null;
  } catch {
    return null;
  }
}

/**
 * Locate the model's generated output directory for a given eval.
 * Prefer MODEL_OUTPUT_DIR when the scorer passes the exact project directory,
 * then fall back to scanning OUTPUT_TEMPDIR and the OS tempdir.
 */
export function getLatestOutputProjectDir(
  category: string,
  name: string,
): string {
  const explicit = getExplicitOutputProjectDir();
  if (explicit) return explicit;

  const configuredRoot = process.env.OUTPUT_TEMPDIR;
  const candidateRoots: { dir: string; mtime: number }[] = [];
  const currentPort = process.env.CONVEX_PORT;

  const addCandidateRoots = (outputRoot: string) => {
    for (const providerDir of readdirSync(outputRoot, {
      withFileTypes: true,
    })) {
      if (!providerDir.isDirectory()) continue;

      const providerPath = join(outputRoot, providerDir.name);
      const oneLevelProjectDir = join(providerPath, category, name);
      try {
        const st = statSync(oneLevelProjectDir);
        if (st.isDirectory()) {
          candidateRoots.push({ dir: oneLevelProjectDir, mtime: st.mtimeMs });
        }
      } catch {
        // not this layout
      }

      for (const modelDir of readdirSync(providerPath, {
        withFileTypes: true,
      })) {
        if (!modelDir.isDirectory()) continue;

        const projectDir = join(providerPath, modelDir.name, category, name);
        try {
          const st = statSync(projectDir);
          if (st.isDirectory()) {
            candidateRoots.push({ dir: projectDir, mtime: st.mtimeMs });
          }
        } catch {
          // not this layout
        }
      }
    }
  };

  if (configuredRoot) {
    const configuredDir = join(configuredRoot, "output");
    try {
      addCandidateRoots(configuredDir);
    } catch {
      // fall through
    }
  }

  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(tmpdir(), entry.name, "output");
    try {
      addCandidateRoots(root);
    } catch {
      // not an eval output dir
    }
  }

  if (candidateRoots.length === 0) {
    throw new Error(`Could not find generated output for ${category}/${name}`);
  }

  if (currentPort) {
    const matchingCurrentRun = candidateRoots.filter(({ dir }) => {
      try {
        const envLocal = readFileSync(join(dir, ".env.local"), "utf8");
        return envLocal.includes(`CONVEX_URL=http://localhost:${currentPort}`);
      } catch {
        return false;
      }
    });

    if (matchingCurrentRun.length > 0) {
      matchingCurrentRun.sort((a, b) => b.mtime - a.mtime);
      return matchingCurrentRun[0].dir;
    }
  }

  candidateRoots.sort((a, b) => b.mtime - a.mtime);
  return candidateRoots[0].dir;
}

/**
 * Read the source file at the given path from the model's output directory
 * and return its contents. Convenience wrapper for AST checks.
 */
export function readOutputFile(
  category: string,
  name: string,
  relativePath: string,
): string {
  const outputProjectDir = getLatestOutputProjectDir(category, name);
  const filePath = join(outputProjectDir, relativePath);
  return readFileSync(filePath, "utf8");
}
