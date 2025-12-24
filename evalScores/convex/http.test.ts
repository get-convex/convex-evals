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

    // Create a valid token first
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

  it("updates existing scores for the same model", async () => {
    const t = convexTest(schema, modules);

    const token = await t.mutation(internal.auth.createToken, {
      name: "test-token",
    });

    // Create initial scores
    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "claude-3",
        scores: { fundamentals: 0.9 },
        totalScore: 0.9,
      }),
    });

    // Update with new scores
    const response = await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "claude-3",
        scores: { fundamentals: 0.95, queries: 0.92 },
        totalScore: 0.935,
      }),
    });

    expect(response.status).toBe(200);

    // Verify the scores were updated
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
});

describe("GET /listScores", () => {
  it("returns empty array when no scores exist", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toEqual([]);
  });

  it("returns all scores", async () => {
    const t = convexTest(schema, modules);

    // Create a token and add some scores
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

    await t.fetch("/updateScores", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.value}` },
      body: JSON.stringify({
        model: "model-b",
        scores: { cat1: 0.8, cat2: 0.85 },
        totalScore: 0.825,
      }),
    });

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScoreEntry[];
    expect(body).toHaveLength(2);
    expect(body).toEqual(
      expect.arrayContaining([
        { model: "model-a", scores: { cat1: 0.9 }, totalScore: 0.9 },
        {
          model: "model-b",
          scores: { cat1: 0.8, cat2: 0.85 },
          totalScore: 0.825,
        },
      ]),
    );
  });

  it("includes CORS headers", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch("/listScores", { method: "GET" });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
