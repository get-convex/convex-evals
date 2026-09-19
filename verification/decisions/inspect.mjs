import { manifest, readArchive, requireArtifact } from "./archive.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === "question") {
  const [sourceEval, questionId] = args;
  const record = manifest.questions.find((item) => item.sourceEval === sourceEval && item.questionId === questionId);
  if (!record) throw new Error("Unknown source eval and question ID");
  console.log(JSON.stringify(record, null, 2));
} else if (command === "artifact") {
  process.stdout.write(requireArtifact(await readArchive(), args[0]));
} else if (command === "list") {
  for (const origin of (await readArchive()).keys()) if (!args[0] || origin.includes(args[0])) console.log(origin);
} else {
  throw new Error("Usage: node verification/decisions/inspect.mjs question <sourceEval> <questionId> | artifact <origin> | list [substring]");
}
