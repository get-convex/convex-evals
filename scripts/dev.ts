/**
 * Dev script that runs evalScores and visualizer concurrently with prefixed output.
 * Usage: bun run dev
 */
import { setupConvexDeployment } from "./setupConvexDeployment";

const services = [
  { name: "evalScores", cmd: ["bun", "run", "dev"], cwd: "evalScores" },
  { name: "visualizer", cmd: ["bun", "run", "dev"], cwd: "visualizer" },
];

const colors = ["\x1b[36m", "\x1b[35m"]; // cyan, magenta
const reset = "\x1b[0m";

function prefix(name: string, color: string, line: string): string {
  return `${color}[${name}]${reset} ${line}`;
}

async function pipeOutput(
  stream: ReadableStream<Uint8Array>,
  name: string,
  color: string,
  target: typeof process.stdout | typeof process.stderr,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      target.write(prefix(name, color, line) + "\n");
    }
  }
  if (buffer) {
    target.write(prefix(name, color, buffer) + "\n");
  }
}

await setupConvexDeployment();

console.log("\nStarting dev servers...\n");

const procs = services.map((svc, i) => {
  const color = colors[i % colors.length];
  const proc = Bun.spawn(svc.cmd, {
    cwd: svc.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  console.log(`${color}[${svc.name}]${reset} started (pid ${proc.pid})`);

  void pipeOutput(proc.stdout, svc.name, color, process.stdout);
  void pipeOutput(proc.stderr, svc.name, color, process.stderr);

  return { ...svc, proc, color };
});

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const { proc, name, color } of procs) {
    proc.kill();
    console.log(`${color}[${name}]${reset} stopped`);
  }
  process.exit(0);
});

// Wait for all processes
const results = await Promise.allSettled(procs.map((p) => p.proc.exited));

for (let i = 0; i < procs.length; i++) {
  const result = results[i];
  const { name, color } = procs[i];
  if (result.status === "fulfilled") {
    console.log(`${color}[${name}]${reset} exited with code ${result.value}`);
  } else {
    console.log(`${color}[${name}]${reset} failed: ${String(result.reason)}`);
  }
}
