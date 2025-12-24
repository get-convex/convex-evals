import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

type ErrorResponse = { error: string };
type SuccessResponse = { success: boolean; id: string };
type ScoreEntry = {
  model: string;
  scores: Record<string, number>;
  totalScore: number;
  totalScoreErrorBar: number;
  scoreErrorBars: Record<string, number>;
  runCount: number;
};

describe("POST /updateScores", () => {
  it("rejects requests without auth token", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/updateScores", {
      method: "POST",
      body: JSON.stringify({
        model: "test-model",
        scores: { category1: 0.9 },
        totalScore: 0.9,
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toBe("Missing authentication token");
  });

  it("rejects requests with invalid auth token", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: "Bearer invalid-token" },
      body: JSON.stringify({
        model: "test-model",
        scores: { category1: 0.9 },
        totalScore: 0.9,
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toBe("Invalid authentication token");
  });

  it("rejects requests with invalid body (missing model)", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        scores: { category1: 0.9 },
        totalScore: 0.9,
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects requests with invalid body (scores not a record)", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "test-model",
        scores: "not-an-object",
        totalScore: 0.9,
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects requests with invalid body (totalScore not a number)", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "test-model",
        scores: { category1: 0.9 },
        totalScore: "not-a-number",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("creates new scores with valid auth and body", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "gpt-4",
        scores: { fundamentals: 0.95, queries: 0.88 },
        totalScore: 0.915,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SuccessResponse;
    expect(body.success).toBe(true);
    expect(body.id).toBeDefined();

    // Verify the scores were saved
    const savedScores = await t.query(api.evalScores.getScores, {
      model: "gpt-4",
    });
    expect(savedScores).toMatchObject({
      model: "gpt-4",
      scores: { fundamentals: 0.95, queries: 0.88 },
      totalScore: 0.915,
    });
  });

  it("appends new scores for the same model (preserves history)", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    // Create initial scores
    const response1 = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "claude-3",
        scores: { fundamentals: 0.9 },
        totalScore: 0.9,
      }),
    });
    expect(response1.status).toBe(200);
    const body1 = (await response1.json()) as SuccessResponse;

    // Add another run
    const response2 = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "claude-3",
        scores: { fundamentals: 0.95, queries: 0.92 },
        totalScore: 0.935,
      }),
    });
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as SuccessResponse;

    // Should have different IDs (both records exist)
    expect(body1.id).not.toBe(body2.id);

    // getScores returns the latest
    const savedScores = await t.query(api.evalScores.getScores, {
      model: "claude-3",
    });
    expect(savedScores).toMatchObject({
      model: "claude-3",
      scores: { fundamentals: 0.95, queries: 0.92 },
      totalScore: 0.935,
    });
  });

  it("accepts token without Bearer prefix", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: token.value },
      body: JSON.stringify({
        model: "test-model",
        scores: { category1: 0.8 },
        totalScore: 0.8,
      }),
    });

    expect(response.status).toBe(200);
  });

  it("accepts optional runId", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "test-model",
        scores: { category1: 0.8 },
        totalScore: 0.8,
        runId: "abc123",
      }),
    });

    expect(response.status).toBe(200);
  });
});

describe("GET /listScores", () => {
  it("returns empty array when no scores exist", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toEqual([]);
  });

  it("returns scores with error bars", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "model-a",
        scores: { cat1: 0.9 },
        totalScore: 0.9,
      }),
    });

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      model: "model-a",
      scores: { cat1: 0.9 },
      totalScore: 0.9,
      totalScoreErrorBar: 0, // Only one run, so no variance
      scoreErrorBars: { cat1: 0 },
      runCount: 1,
    });
  });

  it("computes error bars from multiple runs", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    // Add 3 runs with different scores
    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "model-x",
        scores: { cat1: 0.8 },
        totalScore: 0.8,
      }),
    });

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "model-x",
        scores: { cat1: 0.9 },
        totalScore: 0.9,
      }),
    });

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "model-x",
        scores: { cat1: 1.0 },
        totalScore: 1.0,
      }),
    });

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toHaveLength(1);

    const entry = body[0];
    expect(entry.model).toBe("model-x");
    expect(entry.totalScore).toBe(1.0); // Latest score
    expect(entry.runCount).toBe(3);

    // Standard deviation of [0.8, 0.9, 1.0] = sqrt(((0.8-0.9)^2 + (0.9-0.9)^2 + (1.0-0.9)^2) / 3)
    // = sqrt((0.01 + 0 + 0.01) / 3) = sqrt(0.02/3) ≈ 0.0816
    expect(entry.totalScoreErrorBar).toBeCloseTo(0.0816, 3);
    expect(entry.scoreErrorBars.cat1).toBeCloseTo(0.0816, 3);
  });

  it("returns multiple models sorted by name", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "zebra-model",
        scores: { cat1: 0.9 },
        totalScore: 0.9,
      }),
    });

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "alpha-model",
        scores: { cat1: 0.8 },
        totalScore: 0.8,
      }),
    });

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toHaveLength(2);
    expect(body[0].model).toBe("alpha-model");
    expect(body[1].model).toBe("zebra-model");
  });

  it("includes CORS headers", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
