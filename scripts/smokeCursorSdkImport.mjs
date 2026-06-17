import { Agent } from "@cursor/sdk";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (!Number.isFinite(major) || major < 24) {
  throw new Error(
    `@cursor/sdk requires Node 24+ in this repo; current Node is ${process.version}`,
  );
}

if (typeof Agent.create !== "function") {
  throw new Error("@cursor/sdk did not expose Agent.create");
}

console.log(`@cursor/sdk import smoke passed on ${process.version}`);
