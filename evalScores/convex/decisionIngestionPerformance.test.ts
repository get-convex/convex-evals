import { describe, expect, it } from "vitest";
import {
  BoundedSingleFlightCache,
  decisionSourceCacheKey,
  deepFreeze,
  mapWithConcurrency,
} from "./decisionIngestionPerformance.js";

describe("decision ingestion performance bounds", () => {
  it("loads cold values once, single-flights concurrent misses, and expires warm values", async () => {
    let now = 0;
    let loads = 0;
    const cache = new BoundedSingleFlightCache<{ generation: number }>({
      maxEntries: 2,
      maxBytes: 16,
      ttlMs: 10,
      now: () => now,
    });
    const load = async (): Promise<{
      value: { generation: number };
      sizeBytes: number;
    }> => ({
      value: { generation: ++loads },
      sizeBytes: 4,
    });

    const concurrent = await Promise.all([
      cache.get("source", load),
      cache.get("source", load),
      cache.get("source", load),
    ]);
    expect(concurrent.map((value) => value.generation)).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
    expect((await cache.get("source", load)).generation).toBe(1);

    now = 10;
    expect((await cache.get("source", load)).generation).toBe(2);
    expect(loads).toBe(2);
  });

  it("does not retain failed or oversized loads and isolates every source identity field", async () => {
    const cache = new BoundedSingleFlightCache<string>({
      maxEntries: 1,
      maxBytes: 4,
      ttlMs: 100,
    });
    await expect(
      cache.get("corrupt", async () => {
        throw new Error("source digest mismatch");
      }),
    ).rejects.toThrow("source digest mismatch");
    expect(
      await cache.get("corrupt", async () => ({
        value: "verified",
        sizeBytes: 4,
      })),
    ).toBe("verified");

    let oversizedLoads = 0;
    const oversized = (): Promise<string> =>
      cache.get("oversized", async () => ({
        value: `load-${++oversizedLoads}`,
        sizeBytes: 5,
      }));
    expect(await oversized()).toBe("load-1");
    expect(await oversized()).toBe("load-2");

    const base = {
      deployment: "https://one.convex.cloud",
      storageId: "storage-1",
      sha256: "a".repeat(64),
      benchmarkVersion: "v1",
    };
    const keys = [
      decisionSourceCacheKey(base),
      decisionSourceCacheKey({
        ...base,
        deployment: "https://two.convex.cloud",
      }),
      decisionSourceCacheKey({ ...base, storageId: "storage-2" }),
      decisionSourceCacheKey({ ...base, sha256: "b".repeat(64) }),
      decisionSourceCacheKey({ ...base, benchmarkVersion: "v2" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("freezes cached source trees and caps concurrent evidence reads", async () => {
    const frozen = deepFreeze({ banks: [{ questions: [{ id: "q" }] }] });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.banks[0].questions[0])).toBe(true);

    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 12 }, () =>
      Promise.withResolvers<void>(),
    );
    const mapped = mapWithConcurrency(gates, 3, async (gate, index) => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return index;
    });
    await viWaitFor(() => expect(active).toBe(3));
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    expect(await mapped).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(peak).toBe(3);
  });

  it("stops scheduling new reads after a failure and drains the bounded in-flight set", async () => {
    const started: number[] = [];
    let active = 0;
    await expect(
      mapWithConcurrency(
        Array.from({ length: 12 }, (_, index) => index),
        3,
        async (index) => {
          started.push(index);
          active++;
          await new Promise((resolve) =>
            setTimeout(resolve, index === 1 ? 0 : 5),
          );
          active--;
          if (index === 1) throw new Error("corrupt evidence");
          return index;
        },
      ),
    ).rejects.toThrow("corrupt evidence");
    expect(started).toEqual([0, 1, 2]);
    expect(active).toBe(0);
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
