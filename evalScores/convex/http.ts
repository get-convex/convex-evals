import { httpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const experimentLiteral = z.enum(["no_guidelines"]);

const UpdateScoresBody = z.object({
  model: z.string(),
  scores: z.record(z.string(), z.number()),
  totalScore: z.number(),
  runId: z.string().optional(),
  experiment: experimentLiteral.optional(),
});

const http = httpRouter();

http.route({
  path: "/updateScores",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Parse the request body
      const body: unknown = await request.json();

      // Extract authentication token
      const authHeader = request.headers.get("Authorization");
      const tokenValue = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : authHeader;

      // Validate the token
      if (!tokenValue) {
        return new Response(
          JSON.stringify({ error: "Missing authentication token" }),
          { status: 401 },
        );
      }

      const isValidToken = await ctx.runMutation(internal.auth.validateToken, {
        value: tokenValue,
      });

      if (!isValidToken) {
        return new Response(
          JSON.stringify({ error: "Invalid authentication token" }),
          { status: 401 },
        );
      }

      // Validate the inputs
      const parsed = UpdateScoresBody.safeParse(body);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({ error: parsed.error.issues[0].message }),
          { status: 400 },
        );
      }

      // Update the scores in the database
      const result = await ctx.runMutation(
        internal.evalScores.updateScores,
        parsed.data,
      );

      return new Response(JSON.stringify({ success: true, id: result }), {
        status: 200,
      });
    } catch (error) {
      console.error("Error updating scores:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
      });
    }
  }),
});

http.route({
  path: "/listScores",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const experiment = url.searchParams.get("experiment");

      // Get all model scores from the database
      const allScores = await ctx.runQuery(api.evalScores.listAllScores, {
        experiment: experiment === "no_guidelines" ? "no_guidelines" : undefined,
      });

      // Format the response
      const formattedScores = allScores.map((score) => ({
        model: score.model,
        scores: score.scores,
        totalScore: score.totalScore,
        totalScoreErrorBar: score.totalScoreErrorBar,
        scoreErrorBars: score.scoreErrorBars,
        runCount: score.runCount,
        latestRunId: score.latestRunId,
        latestRunTime: score.latestRunTime,
      }));

      return new Response(JSON.stringify(formattedScores), {
        status: 200,
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          Vary: "origin",
        }),
      });
    } catch (error) {
      console.error("Error listing scores:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }
  }),
});

http.route({
  path: "/listRuns",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const experiment = url.searchParams.get("experiment");
      const includeAll = url.searchParams.get("includeAll") === "true";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      // Get runs from the database
      const runs = await ctx.runQuery(api.evalScores.listAllRuns, {
        experiment: experiment === "no_guidelines" ? "no_guidelines" : undefined,
        includeAllExperiments: includeAll,
        limit,
      });

      return new Response(JSON.stringify(runs), {
        status: 200,
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          Vary: "origin",
        }),
      });
    } catch (error) {
      console.error("Error listing runs:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }
  }),
});

http.route({
  path: "/getModelHistory",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const model = url.searchParams.get("model");
      const experiment = url.searchParams.get("experiment");
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      if (!model) {
        return new Response(
          JSON.stringify({ error: "Missing required parameter: model" }),
          {
            status: 400,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json",
            },
          },
        );
      }

      // Get historical runs for the model
      const history = await ctx.runQuery(api.evalScores.getModelHistory, {
        model,
        experiment: experiment === "no_guidelines" ? "no_guidelines" : undefined,
        limit,
      });

      return new Response(JSON.stringify(history), {
        status: 200,
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          Vary: "origin",
        }),
      });
    } catch (error) {
      console.error("Error getting model history:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }
  }),
});

// Helper function to validate auth token
async function validateAuth(ctx: any, request: Request): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  const tokenValue = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader;

  if (!tokenValue) {
    return null;
  }

  const isValidToken = await ctx.runMutation(internal.auth.validateToken, {
    value: tokenValue,
  });

  return isValidToken ? tokenValue : null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
  Vary: "origin",
};

http.route({
  path: "/startRun",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const StartRunBody = z.object({
        model: z.string(),
        provider: z.string().optional(),
        runId: z.string().optional(),
        plannedEvals: z.array(z.string()),
        experiment: experimentLiteral.optional(),
      });

      const parsed = StartRunBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const result = await ctx.runMutation(internal.runs.createRun, parsed.data);

      return new Response(JSON.stringify({ success: true, runId: result }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error starting run:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

// Check if an asset with this hash exists (for deduplication)
http.route({
  path: "/checkAssetHash",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const CheckHashBody = z.object({
        hash: z.string(),
      });

      const parsed = CheckHashBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const existing = await ctx.runQuery(internal.evalAssets.getByHash, {
        hash: parsed.data.hash,
      });

      if (existing) {
        return new Response(JSON.stringify({ 
          exists: true, 
          storageId: existing.storageId,
        }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({ exists: false }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error checking asset hash:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

// Register a new asset after upload
http.route({
  path: "/registerAsset",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const RegisterAssetBody = z.object({
        hash: z.string(),
        assetType: z.enum(["evalSource", "output"]),
        storageId: z.string(),
      });

      const parsed = RegisterAssetBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const result = await ctx.runMutation(internal.evalAssets.create, {
        hash: parsed.data.hash,
        assetType: parsed.data.assetType,
        storageId: parsed.data.storageId as any,
      });

      return new Response(JSON.stringify({ success: true, assetId: result }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error registering asset:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/startEval",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const StartEvalBody = z.object({
        runId: z.string(),
        evalPath: z.string(),
        category: z.string(),
        name: z.string(),
        task: z.string().optional(),
        evalSourceStorageId: z.string().optional(),
      });

      const parsed = StartEvalBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const result = await ctx.runMutation(internal.evals.createEval, {
        runId: parsed.data.runId as any,
        evalPath: parsed.data.evalPath,
        category: parsed.data.category,
        name: parsed.data.name,
        task: parsed.data.task,
        evalSourceStorageId: parsed.data.evalSourceStorageId as any,
      });

      return new Response(JSON.stringify({ success: true, evalId: result }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error starting eval:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/recordStep",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const RecordStepBody = z.object({
        evalId: z.string(),
        name: z.enum(["filesystem", "install", "deploy", "tsc", "eslint", "tests"]),
        status: z.union([
          z.object({ kind: z.literal("running") }),
          z.object({ kind: z.literal("passed"), durationMs: z.number() }),
          z.object({ kind: z.literal("failed"), failureReason: z.string(), durationMs: z.number() }),
          z.object({ kind: z.literal("skipped") }),
        ]),
      });

      const parsed = RecordStepBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const result = await ctx.runMutation(internal.steps.recordStep, {
        evalId: parsed.data.evalId as any,
        name: parsed.data.name,
        status: parsed.data.status as
          | { kind: "running" }
          | { kind: "passed"; durationMs: number }
          | { kind: "failed"; failureReason: string; durationMs: number }
          | { kind: "skipped" },
      });

      return new Response(JSON.stringify({ success: true, stepId: result }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error recording step:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/completeEval",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const CompleteEvalBody = z.object({
        evalId: z.string(),
        status: z.union([
          z.object({ kind: z.literal("passed"), durationMs: z.number(), outputStorageId: z.string().optional() }),
          z.object({ kind: z.literal("failed"), failureReason: z.string(), durationMs: z.number(), outputStorageId: z.string().optional() }),
        ]),
      });

      const parsed = CompleteEvalBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      await ctx.runMutation(internal.evals.completeEval, {
        evalId: parsed.data.evalId as any,
        status: parsed.data.status as any,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error completing eval:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/completeRun",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body: unknown = await request.json();
      const CompleteRunBody = z.object({
        runId: z.string(),
        status: z.union([
          z.object({ kind: z.literal("completed"), durationMs: z.number() }),
          z.object({ kind: z.literal("failed"), failureReason: z.string(), durationMs: z.number() }),
        ]),
      });

      const parsed = CompleteRunBody.safeParse(body);
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues[0].message }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      await ctx.runMutation(internal.runs.completeRun, {
        runId: parsed.data.runId as any,
        status: parsed.data.status as
          | { kind: "completed"; durationMs: number }
          | { kind: "failed"; failureReason: string; durationMs: number },
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error completing run:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/generateUploadUrl",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const tokenValue = await validateAuth(ctx, request);
      if (!tokenValue) {
        return new Response(JSON.stringify({ error: "Invalid authentication token" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Generate an upload URL for file storage
      const uploadUrl = await ctx.storage.generateUploadUrl();

      return new Response(JSON.stringify({ success: true, uploadUrl }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

http.route({
  path: "/getRunDetails",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const runIdParam = url.searchParams.get("runId");

      if (!runIdParam) {
        return new Response(JSON.stringify({ error: "Missing required parameter: runId" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const runDetails = await ctx.runQuery(api.runs.getRunDetails, {
        runId: runIdParam as any,
      });

      if (!runDetails) {
        return new Response(JSON.stringify({ error: "Run not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify(runDetails), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error getting run details:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }),
});

export default http;
