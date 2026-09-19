import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const repository = path.resolve(directory, "../..");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));

export async function readArchive() {
  const bytes = await fs.readFile(path.join(directory, manifest.bundle.path));
  if (sha256(bytes) !== manifest.bundle.sha256) throw new Error("Evidence bundle digest mismatch");
  const contents = gunzipSync(bytes);
  if (sha256(contents) !== manifest.bundle.uncompressedSha256) throw new Error("Decompressed evidence digest mismatch");
  const artifacts = new Map();
  for (const line of contents.toString("utf8").trimEnd().split("\n")) {
    const item = JSON.parse(line);
    if (artifacts.has(item.origin)) throw new Error(`Duplicate artifact: ${item.origin}`);
    if (sha256(item.content) !== item.sha256) throw new Error(`Artifact digest mismatch: ${item.origin}`);
    if (!item.sanitization.length && item.originalSha256 !== item.sha256) throw new Error(`Unexplained transformation: ${item.origin}`);
    artifacts.set(item.origin, item);
  }
  if (artifacts.size !== manifest.bundle.artifacts) throw new Error("Artifact count mismatch");
  return artifacts;
}

export function requireArtifact(artifacts, origin) {
  const artifact = artifacts.get(origin);
  if (!artifact) throw new Error(`Artifact not packaged: ${origin}`);
  return artifact.content;
}
