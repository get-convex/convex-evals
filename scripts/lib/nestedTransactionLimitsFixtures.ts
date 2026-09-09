import { readFileSync } from "node:fs";

const optionFixtures = [
  {
    name: "literal-limit",
    declarations: "",
    options: "{ transactionLimits: { documentsWritten: 5 } }",
    valid: true,
  },
  {
    name: "inner-shorthand",
    declarations: "const documentsWritten = 5;",
    options: "{ transactionLimits: { documentsWritten } }",
    valid: true,
  },
  {
    name: "outer-shorthand",
    declarations: "const transactionLimits = { documentsWritten: 5 };",
    options: "{ transactionLimits }",
    valid: true,
  },
  {
    name: "both-shorthand",
    declarations:
      "const documentsWritten = 5; const transactionLimits = { documentsWritten };",
    options: "{ transactionLimits }",
    valid: true,
  },
  {
    name: "aliased-shorthand-options",
    declarations:
      "const limit = 5; const documentsWritten = limit; const transactionLimits = { documentsWritten }; const options = { transactionLimits };",
    options: "options",
    valid: true,
  },
  {
    name: "smaller-shorthand-limit",
    declarations: "const documentsWritten = 4;",
    options: "{ transactionLimits: { documentsWritten } }",
    valid: false,
  },
  {
    name: "larger-shorthand-limit",
    declarations: "const documentsWritten = 6;",
    options: "{ transactionLimits: { documentsWritten } }",
    valid: false,
  },
  {
    name: "wrong-limit-through-outer-shorthand",
    declarations: "const transactionLimits = { documentsWritten: 6 };",
    options: "{ transactionLimits }",
    valid: false,
  },
  {
    name: "wrong-limit-through-aliases",
    declarations:
      "const limit = 6; const documentsWritten = limit; const transactionLimits = { documentsWritten }; const options = { transactionLimits };",
    options: "options",
    valid: false,
  },
  {
    name: "missing-write-limit",
    declarations: "const transactionLimits = {};",
    options: "{ transactionLimits }",
    valid: false,
  },
];

const reference = readFileSync(
  new URL(
    "../../evals/005-idioms/008-nested_transaction_limits/answer/convex/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const options = "{ transactionLimits: { documentsWritten: 5 } }";
const args = "{ jobId: args.jobId, count: args.count }";
const call = `ctx.runMutation(
        internal.index.writeDeliveries,
        ${args},
        ${options},
      )`;
if (!reference.includes(call))
  throw new Error("Update the nested-limit fixture template");

function fixture(
  name: string,
  valid: boolean,
  source: string,
  files: Record<string, string> = {},
): { name: string; valid: boolean; files: Record<string, string> } {
  return { name, valid, files: { "convex/index.ts": source, ...files } };
}

const helper = `import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
export async function fanout(ctx: MutationCtx, args: { jobId: Id<"jobs">; count: number }): Promise<null> {
  return await ctx.runMutation(internal.index.writeDeliveries, args, ${options});
}`;
const manualGate = `if (args.count > 5) {
      await ctx.db.patch("jobs", args.jobId, { status: "rejected" });
      return "rejected";
    }`;
const uncapped = reference.replace(
  call,
  `ctx.runMutation(internal.index.writeDeliveries, ${args})`,
);

// The same complete programs feed the sandbox unit suite and local full-pipeline
// regressions. Every valid alternative must also work on a real Convex backend.
export const nestedTransactionLimitsFixtures = [
  fixture(
    "native-function-handle",
    true,
    'import { createFunctionHandle } from "convex/server";\n' +
      reference.replace(
        "internal.index.writeDeliveries,",
        "await createFunctionHandle(internal.index.writeDeliveries),",
      ),
  ),
  fixture(
    "wrong-limit-through-function-handle",
    false,
    'import { createFunctionHandle } from "convex/server";\n' +
      reference
        .replace(
          "internal.index.writeDeliveries,",
          "await createFunctionHandle(internal.index.writeDeliveries),",
        )
        .replace(options, "{ transactionLimits: { documentsWritten: 6 } }"),
  ),
  fixture(
    "wrong-count-through-function-handle",
    false,
    'import { createFunctionHandle } from "convex/server";\n' +
      reference
        .replace(
          "internal.index.writeDeliveries,",
          "await createFunctionHandle(internal.index.writeDeliveries),",
        )
        .replace(args, "{ jobId: args.jobId, count: 0 }"),
  ),
  ...optionFixtures.map((f) =>
    fixture(
      f.name,
      f.valid,
      reference.replace(options, f.options) + "\n" + f.declarations,
    ),
  ),
  fixture(
    "quoted-keys",
    true,
    reference.replace(
      options,
      '{ "transactionLimits": { "documentsWritten": 5 } }',
    ),
  ),
  fixture(
    "computed-limit-and-spread",
    true,
    reference.replace(
      options,
      '{ ...{ transactionLimits: { ["documents" + "Written"]: 2 + 3 } } }',
    ),
  ),
  fixture(
    "local-helper",
    true,
    reference.replace(call, "fanout(ctx, args)") +
      `
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
async function fanout(ctx: MutationCtx, args: { jobId: Id<"jobs">; count: number }): Promise<null> {
  return await ctx.runMutation(internal.index.writeDeliveries, args, ${options});
}`,
  ),
  fixture(
    "imported-helper",
    true,
    'import { fanout } from "./helper";\n' +
      reference.replace(call, "fanout(ctx, args)"),
    { "convex/helper.ts": helper },
  ),
  fixture(
    "destructured-runMutation",
    true,
    reference
      .replace("    try {", "    const { runMutation } = ctx;\n    try {")
      .replace(
        call,
        `runMutation(internal.index.writeDeliveries, ${args}, ${options})`,
      ),
  ),
  fixture(
    "job-query-read",
    true,
    reference.replace(
      "    try {",
      `
    const job = await ctx.db.query("jobs").filter(q => q.eq(q.field("_id"), args.jobId)).unique();
    if (!job) throw new Error("Missing job");
    const deliveries = await ctx.db.query("deliveries").withIndex("by_jobId", q => q.eq("jobId", args.jobId)).collect();
    if (deliveries.length) throw new Error("Already processed");
    try {`,
    ),
  ),
  fixture(
    "job-index-and-page-read",
    true,
    reference.replace(
      "    try {",
      `
    const jobs = await ctx.db.query("jobs").withIndex("by_creation_time", q => q.gte("_creationTime", 0))
      .filter(q => q.and(q.eq(q.field("_id"), args.jobId), q.neq(q.field("status"), "completed")))
      .paginate({ cursor: null, numItems: 1 });
    if (!jobs.page.length) throw new Error("Missing job");
    try {`,
    ),
  ),
  fixture(
    "job-point-read",
    true,
    reference.replace(
      "    try {",
      `
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) throw new Error("Missing job");
    try {`,
    ),
  ),
  fixture(
    "legacy-job-point-read",
    true,
    reference.replace(
      "    try {",
      `
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Missing job");
    try {`,
    ),
  ),
  fixture(
    "job-read-and-replace",
    true,
    reference.replace(
      "    try {",
      `
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) throw new Error("Missing job");
    await ctx.db.replace("jobs", args.jobId, { name: job.name, status: job.status });
    try {`,
    ),
  ),
  fixture(
    "job-normalize-and-patch",
    true,
    reference.replace(
      "    try {",
      `
    const jobId = ctx.db.normalizeId("jobs", args.jobId);
    if (!jobId) throw new Error("Invalid job");
    await ctx.db.patch(jobId, { status: "pending" });
    try {`,
    ),
  ),
  fixture(
    "unused-wrong-limit-is-harmless",
    true,
    reference.replace(
      "    try {",
      `
    const example = () => ctx.runMutation(internal.index.writeDeliveries, ${args},
      { transactionLimits: { documentsWritten: 6 } });
    void example;
    try {`,
    ),
  ),
  fixture(
    "unused-native-limit-and-manual-gate",
    false,
    uncapped.replace(
      "    try {",
      `
    const example = () => ctx.runMutation(internal.index.writeDeliveries, ${args}, ${options});
    void example;
    ${manualGate}
    try {`,
    ),
  ),
  fixture(
    "native-limit-only-for-small-counts",
    false,
    reference.replace(
      options,
      "{ transactionLimits: { documentsWritten: args.count <= 5 ? 5 : 6 } }",
    ),
  ),
  fixture(
    "manual-overflow-shortcut",
    false,
    reference.replace("    try {", `${manualGate}\n    try {`),
  ),
  fixture(
    "cap-on-unrelated-call",
    false,
    uncapped.replace(
      "    try {",
      `
    await ctx.runQuery(internal.index.unrelated, {}, ${options});
    ${manualGate}
    try {`,
    ) +
      `
import { internalQuery } from "./_generated/server";
export const unrelated = internalQuery({ args: {}, handler: async () => null });`,
  ),
  fixture(
    "limited-decoy-with-zero-count",
    false,
    uncapped.replace(
      "    try {",
      `
    await ctx.runMutation(internal.index.writeDeliveries, { jobId: args.jobId, count: 0 }, ${options});
    ${manualGate}
    try {`,
    ),
  ),
  fixture(
    "wrong-job-id",
    false,
    reference.replace(
      args,
      '{ jobId: "wrong-job-id" as typeof args.jobId, count: args.count }',
    ),
  ),
  fixture(
    "clamped-child-count",
    false,
    reference.replace(
      args,
      "{ jobId: args.jobId, count: Math.min(args.count, 5) }",
    ),
  ),
  fixture(
    "shadowed-limit",
    false,
    reference
      .replace(options, "{ transactionLimits: { documentsWritten } }")
      .replace("    try {", "    const documentsWritten = 6;\n    try {") +
      "\nconst documentsWritten = 5;",
  ),
];
