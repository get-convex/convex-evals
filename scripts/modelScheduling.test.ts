import { describe, expect, it } from "vitest";
import {
  computeCostMinimumIntervalMs,
  computeTargetIntervalMs,
  getSchedulingDecision,
} from "./modelScheduling.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const HALF_SATURATION_DAYS = 365;

describe("computeTargetIntervalMs", () => {
  it("returns the minimum interval when first-seen is missing", () => {
    expect(computeTargetIntervalMs(null, 1_000_000)).toBe(DAY_MS);
  });

  it("returns the minimum interval for a brand new model", () => {
    const now = 31 * DAY_MS;
    expect(computeTargetIntervalMs(now, now)).toBe(DAY_MS);
  });

  it("returns ~30d at the half-saturation point (365 days old)", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - HALF_SATURATION_DAYS * DAY_MS;
    const result = computeTargetIntervalMs(firstSeen, now);
    // At half-saturation: MIN + (MAX - MIN) * 0.5 = 1 + 59 * 0.5 = 30.5 days
    expect(result).toBeCloseTo(30.5 * DAY_MS, -6);
  });

  it("returns ~20d for a 180-day-old model", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - 180 * DAY_MS;
    const result = computeTargetIntervalMs(firstSeen, now);
    // 1 + 59 * 180 / (180 + 365) ≈ 20.5 days
    expect(result).toBeGreaterThan(19 * DAY_MS);
    expect(result).toBeLessThan(22 * DAY_MS);
  });

  it("returns ~5.5d for a 30-day-old model", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - 30 * DAY_MS;
    const result = computeTargetIntervalMs(firstSeen, now);
    // 1 + 59 * 30 / (30 + 365) ≈ 5.5 days
    expect(result).toBeGreaterThan(4 * DAY_MS);
    expect(result).toBeLessThan(7 * DAY_MS);
  });

  it("approaches but never reaches 60 days for very old models", () => {
    const now = 10_000 * DAY_MS;
    const result = computeTargetIntervalMs(0, now);
    expect(result).toBeGreaterThan(55 * DAY_MS);
    expect(result).toBeLessThan(60 * DAY_MS);
  });

  it("keeps cheap models at the age-based interval", () => {
    const now = 31 * DAY_MS;
    expect(computeTargetIntervalMs(now, now, 5)).toBe(DAY_MS);
  });

  it("enforces a longer minimum interval for very expensive models", () => {
    const now = 31 * DAY_MS;
    expect(computeTargetIntervalMs(now, now, 50)).toBe(14 * DAY_MS);
  });

  it("does not let cost bias shorten old-model intervals", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - 365 * DAY_MS;
    const result = computeTargetIntervalMs(firstSeen, now, 50);
    expect(result).toBeCloseTo(30.5 * DAY_MS, -6);
  });
});

describe("computeCostMinimumIntervalMs", () => {
  it("returns the minimum interval without cost data", () => {
    expect(computeCostMinimumIntervalMs(null)).toBe(DAY_MS);
  });

  it("ramps expensive runs up to a 14 day minimum interval", () => {
    expect(computeCostMinimumIntervalMs(50)).toBe(14 * DAY_MS);
    expect(computeCostMinimumIntervalMs(500)).toBe(14 * DAY_MS);
  });
});

describe("getSchedulingDecision", () => {
  it("marks models with no runs as due immediately", () => {
    const decision = getSchedulingDecision(null, 10 * DAY_MS, 20 * DAY_MS);
    expect(decision.isDue).toBe(true);
  });

  it("marks a model due when the elapsed time meets the target interval", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - 180 * DAY_MS;
    const targetIntervalMs = computeTargetIntervalMs(firstSeen, now);
    const decision = getSchedulingDecision(now - targetIntervalMs, firstSeen, now);
    expect(decision.targetIntervalMs).toBe(targetIntervalMs);
    expect(decision.isDue).toBe(true);
  });

  it("marks a model not due when the elapsed time is below the target interval", () => {
    const now = 1000 * DAY_MS;
    const firstSeen = now - 180 * DAY_MS;
    const targetIntervalMs = computeTargetIntervalMs(firstSeen, now);
    const decision = getSchedulingDecision(now - targetIntervalMs + 1, firstSeen, now);
    expect(decision.isDue).toBe(false);
  });

  it("uses cost-biased target intervals when average run cost is high", () => {
    const now = 31 * DAY_MS;
    const decision = getSchedulingDecision(
      now - 2 * DAY_MS,
      now,
      now,
      50,
    );
    expect(decision.targetIntervalMs).toBe(14 * DAY_MS);
    expect(decision.averageRunCostUsd).toBe(50);
    expect(decision.isDue).toBe(false);
  });
});
