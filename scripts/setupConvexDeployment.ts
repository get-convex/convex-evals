import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const devDeployment = "brazen-pelican-414";
const devUrl = `https://${devDeployment}.convex.cloud`;

const envTargets = [
  {
    path: "evalScores/.env.local",
    values: {
      CONVEX_DEPLOYMENT: devDeployment,
      CONVEX_URL: devUrl,
    },
  },
  {
    path: "visualizer/.env.local",
    values: {
      VITE_CONVEX_URL: devUrl,
    },
  },
] as const;

type SetupOptions = {
  verbose?: boolean;
};

function setEnvValues(
  contents: string,
  values: Readonly<Record<string, string>>,
): string {
  const remaining = new Set(Object.keys(values));
  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match === null) {
      return line;
    }

    const [, key] = match;
    if (!remaining.has(key)) {
      return line;
    }

    remaining.delete(key);
    return `${key}=${values[key]}`;
  });

  if (updatedLines.at(-1) === "") {
    updatedLines.pop();
  }

  for (const key of remaining) {
    updatedLines.push(`${key}=${values[key]}`);
  }

  return `${updatedLines.join("\n")}\n`;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export async function setupConvexDeployment({
  verbose = true,
}: SetupOptions = {}) {
  let changed = false;

  for (const target of envTargets) {
    await mkdir(dirname(target.path), { recursive: true });

    const previous = await readIfExists(target.path);
    const next = setEnvValues(previous, target.values);

    if (next !== previous) {
      await writeFile(target.path, next, "utf8");
      changed = true;
    }

    if (verbose) {
      console.log(
        `${next === previous ? "Already configured" : "Configured"} ${target.path}`,
      );
    }
  }

  if (verbose) {
    console.log(`Using Convex dev deployment ${devDeployment} (${devUrl})`);
  }

  return { changed, deployment: devDeployment, url: devUrl };
}

if (import.meta.main) {
  await setupConvexDeployment();
}
