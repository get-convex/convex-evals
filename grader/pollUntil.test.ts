import { describe, expect, test } from "vitest";
import { pollUntil } from "./pollUntil.js";

describe("pollUntil", () => {
  test("resolves immediately when the predicate is already true", async () => {
    let calls = 0;
    await pollUntil(
      () => {
        calls++;
        return true;
      },
      { timeoutMs: 1000, intervalMs: 100 },
    );
    expect(calls).toBe(1);
  });

  test("resolves once the predicate becomes true", async () => {
    let calls = 0;
    await pollUntil(
      async () => {
        calls++;
        return calls >= 3;
      },
      { timeoutMs: 1000, intervalMs: 10 },
    );
    expect(calls).toBe(3);
  });

  test("throws a descriptive error on timeout", async () => {
    await expect(
      pollUntil(() => false, { timeoutMs: 50, intervalMs: 10 }),
    ).rejects.toThrow(/condition not met within 50ms/);
  });
});
