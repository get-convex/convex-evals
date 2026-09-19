// These adapters replay recorded cases; they never execute the historical author
// scripts or replace the exact displayed options with equivalent implementations.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { repository, requireArtifact, sha256 } from "./archive.mjs";

const codeBlock = (text) => text.replace(/^```ts\n|\n```$/g, "");

export async function replayAdditional(mode, harness) {
  const { artifacts, temporary, report, clean, command, install, bindQuestion, startBackend } = harness;
  const archived = (origin) => requireArtifact(artifacts, origin);
  const json = (origin) => JSON.parse(archived(origin));
  const modules = await install(path.join(temporary, "dependencies"), mode === "agent-attribution" ? "agent-0.6.4" : "1.44.0");
  const { url, admin } = await startBackend();
  const { ConvexHttpClient } = await import(pathToFileURL(path.join(modules, "convex/dist/esm/browser/index.js")));
  const client = new ConvexHttpClient(url, { logger: false });

  async function fixture(name, sourceEval, files, expectedSchema) {
    const project = path.join(temporary, name);
    const source = path.join(repository, "evals", sourceEval, "answer");
    const sourceSchema = await fs.readFile(path.join(source, "convex/schema.ts"));
    assert.equal(sha256(sourceSchema), expectedSchema, "Original source schema changed");
    await fs.cp(source, project, { recursive: true, filter: (p) => !["node_modules", ".git", ".convex"].includes(path.basename(p)) && !path.basename(p).startsWith(".env") });
    for (const [relative, contents] of Object.entries(files)) {
      assert.notEqual(relative, "convex/schema.ts", "Replay must reuse the unchanged source schema");
      await fs.writeFile(path.join(project, relative), contents);
    }
    await fs.symlink(modules, path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(sha256(await fs.readFile(path.join(project, "convex/schema.ts"))), expectedSchema);
    return project;
  }

  async function typecheck(project, config = "convex/tsconfig.json") {
    const result = await command(process.execPath, [path.join(modules, "typescript/bin/tsc"), "--noEmit", "--pretty", "false", "-p", config], project);
    return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr) };
  }

  async function deploy(project) {
    const result = await command(process.execPath, [path.join(modules, "convex/bin/main.js"), "dev", "--once", "--typecheck", "disable", "--url", url, "--admin-key", admin], project);
    return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr), typecheckDeliberatelyDisabled: true };
  }

  async function attempt(fn) {
    try { return { ok: true, value: await fn() }; }
    catch (error) { return { ok: false, error: clean(error) }; }
  }

  if (mode === "document-validator") {
    const sourceEval = "001-data_modeling/016-schema_document_validator";
    const question = await bindQuestion(sourceEval, "q1");
    const saved = json(`outputs/failure-pilot/evidence/${sourceEval}/execution-evidence.json`);
    const prefix = "work/failure-pilot/author-data/016-schema_document_validator/runs/2026-09-17T23-15-36-373Z/variants/";
    for (const name of ["a", "b", "c", "d", "repair_a", "repair_c", "repair_d"]) {
      const probe = archived(`${prefix}${name}/convex/probe.ts`);
      const displayed = name.startsWith("repair_") ? saved.repairs[name.slice(7)] : codeBlock(question.options.find((o) => o.id === name).text);
      assert.ok(probe.includes(displayed), `Exact option or repair absent: ${name}`);
      assert.equal(sha256(probe), saved.variants[name].executedFileSha256);
      const project = await fixture(name, sourceEval, {
        "convex/probe.ts": probe,
        "convex/fixtures.ts": archived(`${prefix}${name}/convex/fixtures.ts`),
        "tsconfig.probe.json": archived(`${prefix}${name}/tsconfig.probe.json`),
      }, saved.originalSchemaSha256);
      const staticResult = await typecheck(project, "tsconfig.probe.json");
      const absentMethod = name === "c" || name === "d";
      assert.equal(staticResult.code, absentMethod ? 2 : 0, staticResult.stdout);
      if (absentMethod) assert.match(staticResult.stdout, /Property '(doc|validator)' does not exist/);
      const deployment = await deploy(project);
      const observation = { variant: name, fixtureSha256: sha256(probe), static: staticResult, deployment, argumentProbes: [] };
      report.observations.push(observation);
      if (absentMethod) {
        assert.notEqual(deployment.code, 0);
        assert.match(deployment.stderr, /(?:doc|validator) is not a function/);
        observation.failureClass = "module initialization failed; no argument probes executed";
        continue;
      }
      assert.equal(deployment.code, 0, deployment.stderr);
      // Fresh stored documents give real table-specific IDs. IDs are not copied
      // from historical state, and the deleted row tests validation vs existence.
      const full = await client.mutation("fixtures:seed", { displayName: "Ada", bio: "Saved bio" });
      const empty = await client.mutation("fixtures:seed", { displayName: "", bio: "" });
      const deleted = await client.mutation("fixtures:seed", { displayName: "Deleted row", bio: "Still a valid snapshot" });
      await client.mutation("fixtures:remove", { id: deleted._id });
      const foreignId = await client.mutation("fixtures:foreignId", {});
      const substitutions = new Map([
        [saved.fixtures.full._id, full._id], [saved.fixtures.full._creationTime, full._creationTime],
        [saved.fixtures.empty._id, empty._id], [saved.fixtures.empty._creationTime, empty._creationTime],
        [saved.fixtures.deleted._id, deleted._id], [saved.fixtures.deleted._creationTime, deleted._creationTime],
        [saved.fixtures.foreignId, foreignId],
      ]);
      function freshInput(value) {
        if (substitutions.has(value)) return substitutions.get(value);
        if (Array.isArray(value)) return value.map(freshInput);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freshInput(item)]));
        return value;
      }
      // Reuse exact recorded case payloads, replacing only backend-generated
      // IDs/timestamps with their newly seeded equivalents.
      const cases = saved.variants.b.argumentProbes.map(({ label, input }) => [label, freshInput(input)]);
      assert.deepEqual(cases.map(([label]) => label), saved.independentCaseSpecs.map(([label]) => label));
      for (const [label, input] of cases) {
        const expectedAccept = saved.independentCaseSpecs.find(([name]) => name === label)[1];
        const actual = await attempt(() => client.mutation("probe:check", { snapshot: input }));
        const expectedObserved = name === "a" ? label === "application fields only" : expectedAccept;
        assert.equal(actual.ok, expectedObserved, `${name}: ${label}`);
        if (actual.ok) assert.deepEqual(actual.value, input);
        else assert.match(actual.error, /ArgumentValidationError/);
        observation.argumentProbes.push({ label, input, expectedAccept, actual, matchesContract: actual.ok === expectedAccept });
      }
    }
    report.limitations.push("Argument-validator execution with the unchanged original table schema. Does not test restore logic, authorization, existence checks, or alternate-schema deployment. Missing-method variants fail module initialization and have no runtime argument cases.");
  } else if (mode === "nested-limits") {
    const sourceEval = "005-idioms/008-nested_transaction_limits";
    const question = await bindQuestion(sourceEval, "q1");
    const saved = json(`outputs/failure-pilot/evidence/${sourceEval}/execution-evidence.json`);
    const files = {};
    const names = ["a", "b", "c", "d", "repaired_a", "repaired_b", "repaired_d"];
    for (const name of names) {
      const binding = saved.provenance.optionBindings[name];
      const source = archived(binding.file);
      assert.equal(sha256(source), binding.fileSha256);
      const displayed = codeBlock(question.options.find((o) => o.id === (name.startsWith("repaired_") ? "c" : name)).text);
      assert.equal(sha256(displayed), binding.executableSnippetSha256);
      assert.equal(source.split(displayed).length - 1, 2, "Both ordinary and diagnostic wrappers must use the exact option");
      files[`convex/${name}.ts`] = source;
      files[`tsconfig.${name}.json`] = JSON.stringify({ extends: "./convex/tsconfig.json", include: [`convex/${name}.ts`, "convex/schema.ts"] });
    }
    // The original source snapshot records the helper verbatim as a template.
    // Extract that literal only; never execute the historical author program.
    const script = archived(saved.provenance.scriptSnapshot);
    const helper = script.match(/const helpers = `([\s\S]*?)`;\n/)[1];
    assert.equal(sha256(helper), saved.provenance.proofHelpersSha256);
    files["convex/proof.ts"] = helper;
    const project = await fixture("nested-limits", sourceEval, files, saved.provenance.sourceFiles["answer/convex/schema.ts"]);
    assert.equal(sha256(await fs.readFile(path.join(project, "convex/index.ts"))), saved.provenance.sourceFiles["answer/convex/index.ts"]);
    const staticResults = {};
    for (const name of names) {
      const result = await typecheck(project, `tsconfig.${name}.json`);
      const correct = name === "c" || name.startsWith("repaired_");
      assert.equal(result.code, correct ? 0 : 2, result.stdout);
      if (!correct) assert.match(result.stdout, /maxNumWrites|limits|maxWrites/);
      staticResults[name] = result;
    }
    const deployment = await deploy(project);
    assert.equal(deployment.code, 0, deployment.stderr);
    // Admin access is used only for the explicit uncapped internal-child control.
    const adminClient = new ConvexHttpClient(url, { logger: false });
    adminClient.setAdminAuth(admin);
    const neighbor = await client.mutation("proof:seed", { name: "unrelated-job" });
    await adminClient.mutation("index:writeDeliveries", { jobId: neighbor, count: 3 });
    const neighborBefore = await client.query("proof:observe", { jobId: neighbor });
    for (const name of names) {
      const capped = name === "c" || name.startsWith("repaired_");
      const observation = { variant: name, fixtureSha256: sha256(files[`convex/${name}.ts`]), static: staticResults[name], deployment, cases: [] };
      report.observations.push(observation);
      for (const count of [0, 1, 2, 5, 6, 10]) {
        const jobId = await client.mutation("proof:seed", { name: `${name}-count-${count}` });
        const returned = await client.mutation(`${name}:run`, { jobId, count });
        const snapshot = await client.query("proof:observe", { jobId });
        const rejected = capped && count > 5;
        const expectedContract = { returned: count > 5 ? "rejected" : "completed", deliveryCount: count > 5 ? 0 : count };
        assert.equal(returned, rejected ? "rejected" : "completed");
        assert.equal(snapshot.job.status, returned);
        assert.equal(snapshot.deliveries.length, rejected ? 0 : count);
        assert.deepEqual(snapshot.deliveries.map((d) => d.recipient).sort(), Array.from({ length: rejected ? 0 : count }, (_, i) => `recipient-${i}`).sort());
        assert.deepEqual(await client.query("proof:observe", { jobId: neighbor }), neighborBefore);
        observation.cases.push({ count, expectedContract, actual: { returned, snapshot, neighborUnchanged: true }, matchesContract: returned === expectedContract.returned && snapshot.deliveries.length === expectedContract.deliveryCount });
      }
      const jobId = await client.mutation("proof:seed", { name: `${name}-diagnostic` });
      const actual = await client.mutation(`${name}:diagnose`, { jobId, count: 6 });
      const snapshot = await client.query("proof:observe", { jobId });
      assert.equal(actual.status, capped ? "rejected" : "completed");
      assert.equal(snapshot.deliveries.length, capped ? 0 : 6);
      if (capped) assert.match(actual.error, /Too many writes|documents written|write limit|write operations/i);
      else assert.equal(actual.error, null);
      observation.diagnostic = { count: 6, actual, snapshot };
    }
    const directId = await client.mutation("proof:seed", { name: "uncapped-control" });
    await adminClient.mutation("index:writeDeliveries", { jobId: directId, count: 6 });
    const direct = await client.query("proof:observe", { jobId: directId });
    assert.equal(direct.deliveries.length, 6);
    assert.equal(direct.job.status, "pending");
    report.uncappedControl = direct;
    report.limitations.push("Tests only the recorded nonnegative counts 0, 1, 2, 5, 6 and 10 and native document-write limits. Intentionally rejected option shapes execute with typechecking bypassed. Does not establish arbitrary resource limits, concurrent behavior, or independent parent/child implementation ability.");
  } else if (mode === "agent-attribution") {
    const sourceEval = "007-components/017-choose_agent_multi";
    const question = await bindQuestion(sourceEval, "q1");
    const prefix = "outputs/bank-revision/actions_components-03/";
    for (const name of ["agent-multi", "agent-reference-multi"]) {
      const saved = json(`${prefix}execution/2026-09-18T02-57-44-724Z-35edafcc/${name}.json`);
      const source = archived(`${prefix}programs/${name}.ts`);
      assert.equal(sha256(source), saved.fixture.displayedFileHashes["convex/index.ts"]);
      if (name === "agent-multi") assert.ok(source.includes(question.context.match(/```ts\n([\s\S]*?)\n```/)[1]));
      const project = await fixture(name, sourceEval, { "convex/index.ts": source }, saved.fixture.originalSchemas["convex/schema.ts"]);
      const deployment = await deploy(project);
      assert.equal(deployment.code, 0, deployment.stderr);
      const staticResult = await typecheck(project);
      assert.equal(staticResult.code, 0, staticResult.stdout);
      let actual;
      if (name === "agent-multi") {
        const threadId = await client.mutation("index:open", {});
        const first = await client.action("index:send", { threadId, name: "triage", text: "customer" });
        const second = await client.action("index:send", { threadId, name: "billing", text: "take over" });
        const history = await client.query("index:history", { threadId });
        assert.equal(first.text, "reply"); assert.equal(second.text, "reply");
        assert.deepEqual(history, saved.actual.history);
        const authors = history.map((doc) => doc.author);
        const predictions = question.options.map((option) => ({ id: option.id, prediction: JSON.parse(option.text), matches: JSON.stringify(JSON.parse(option.text)) === JSON.stringify(authors) }));
        assert.deepEqual(predictions.filter((option) => option.matches).map((option) => option.id), [question.correctOptionId]);
        const calls = JSON.parse(second.callsJson);
        assert.deepEqual(calls[0].prompt.map((message) => message.role), ["user", "assistant", "user"]);
        actual = { history, authors, predictions, first, second: { ...second, calls } };
      } else {
        const threadId = await client.mutation("index:openConversation", { userId: "customer" });
        const first = await client.action("index:triage", { threadId, text: "Billing issue" });
        const second = await client.action("index:escalateToBilling", { threadId });
        const transcript = await client.query("index:getTranscript", { threadId });
        assert.deepEqual(transcript, saved.actual.transcript);
        actual = { transcript, first, second };
      }
      report.observations.push({ variant: name, fixtureSha256: sha256(source), static: staticResult, deployment, actual, repairControl: "not applicable: outcome prediction" });
    }
    report.limitations.push("Agent 0.6.4 with Convex 1.41.0 and the recorded deterministic local model. Verifies persistence/attribution, with no provider calls or quality claim. The original-reference control suppresses the handoff prompt and manually saves the billing reply; it is deliberately separate from the four-message displayed question.");
  }
}
