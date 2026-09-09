import { afterAll, beforeAll, test as bunTest } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ADMIN_KEY,
  startConvexBackend,
  stopConvexBackend,
  type ConvexBackend,
} from "../../runner/convexBackend";
import { withQueryProbeBackend } from "../../grader/querySandbox";

// These are integration tests: the same Convex runtime executes the probe in
// both this fixture suite and the full scorer. Each suite owns its backend.
export function nativeProbeTest(
  reference?: string,
  setup?: (backend: ConvexBackend) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "native-query-probe-"));
  let backend: ConvexBackend | undefined;
  beforeAll(async () => {
    backend = await startConvexBackend(dir);
    if (!reference) {
      await setup?.(backend);
      return;
    }

    // Native function handles resolve deployed function addresses. Install the
    // existing reference solely to make those addresses available to the probe.
    const project = join(dir, "project");
    mkdirSync(project);
    for (const name of ["convex", "package.json", "convex.json"]) {
      const source = resolve(reference, name);
      if (existsSync(source))
        cpSync(source, join(project, name), { recursive: true });
    }
    symlinkSync(
      resolve("node_modules"),
      join(project, "node_modules"),
      "junction",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "x",
        "convex",
        "dev",
        "--once",
        "--typecheck",
        "disable",
        "--url",
        `http://localhost:${backend.port}`,
        "--admin-key",
        ADMIN_KEY,
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        `Probe reference deployment failed: ${stdout}\n${stderr}`,
      );
    await setup?.(backend);
  }, 120_000);
  afterAll(async () => {
    if (backend) {
      stopConvexBackend(backend);
      await backend.process.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return (name: string, run: () => unknown, timeout = 15_000) =>
    bunTest(
      name,
      async () => {
        if (!backend) throw new Error("Probe test backend did not start");
        await withQueryProbeBackend(backend.port, run);
      },
      timeout,
    );
}
