import { httpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const UpdateScoresBody = z.object({
  model: z.string(),
  scores: z.record(z.string(), z.number()),
  totalScore: z.number(),
  runId: z.string().optional(),
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
      // Get all model scores from the database
      const allScores = await ctx.runQuery(api.evalScores.listAllScores, {});

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

export default http;
