import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { manifest, repository, readArchive, sha256 } from "./archive.mjs";

const artifacts = await readArchive();
const discovered = [];
for (const category of await fs.readdir(path.join(repository, "evals"), { withFileTypes: true })) {
  if (!category.isDirectory()) continue;
  for (const source of await fs.readdir(path.join(repository, "evals", category.name), { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    const relative = `evals/${category.name}/${source.name}/questions.json`;
    try { await fs.access(path.join(repository, relative)); discovered.push(relative); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
assert.deepEqual(discovered.sort(), Object.keys(manifest.questionFiles).sort(), "Question file inventory differs from the frozen bank");
let questions = 0;
for (const [relative, expected] of Object.entries(manifest.questionFiles)) {
  const bytes = await fs.readFile(path.join(repository, relative));
  assert.equal(sha256(bytes), expected, `Frozen question file changed: ${relative}`);
  const bank = JSON.parse(bytes);
  for (const question of bank.questions) {
    const record = manifest.questions.find((item) => item.sourceEval === bank.sourceEval && item.questionId === question.id);
    assert.ok(record, `Unlisted question: ${bank.sourceEval}/${question.id}`);
    assert.equal(sha256(JSON.stringify(question)), record.questionSha256, "Question hash mismatch");
    assert.equal(question.correctOptionId, record.correctOptionId, "Answer key mismatch");
    assert.equal(question.options.length, 4);
    for (const option of question.options) assert.equal(sha256(option.text), record.optionSha256[option.id], "Option hash mismatch");
    for (const origin of [...record.evidence, record.authorRecord, record.review]) {
      assert.ok(artifacts.has(origin), `Missing evidence: ${origin}`);
    }
    questions++;
  }
}
assert.equal(questions, manifest.questionCount);
assert.equal(manifest.questions.length, questions);
console.log(JSON.stringify({ status: "passed", questions, questionFiles: Object.keys(manifest.questionFiles).length, artifacts: artifacts.size, runtimeReplayed: false }, null, 2));
