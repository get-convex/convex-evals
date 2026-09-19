/** Small process-local cache for source snapshots that have already passed the
 * full byte, digest, canonical JSON, projection, and benchmark checks.
 *
 * Convex storage IDs are immutable. The key must still include the deployment,
 * storage ID, digest, and benchmark version so one isolate can never reuse a
 * value for a different source identity. */
export class BoundedSingleFlightCache<T> {
  private readonly entries = new Map<
    string,
    { value: T; sizeBytes: number; expiresAt: number; lastUsedAt: number }
  >();
  private readonly inFlight = new Map<string, Promise<T>>();
  private totalBytes = 0;

  constructor(
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      ttlMs: number;
      now?: () => number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 1
    ) {
      throw new Error("Invalid bounded cache limits");
    }
  }

  async get(
    key: string,
    load: () => Promise<{ value: T; sizeBytes: number }>,
  ): Promise<T> {
    const now = (this.options.now ?? Date.now)();
    this.pruneExpired(now);
    const cached = this.entries.get(key);
    if (cached) {
      cached.lastUsedAt = now;
      return cached.value;
    }
    const pending = this.inFlight.get(key);
    if (pending) return await pending;

    const promise = (async () => {
      const loaded = await load();
      if (
        !Number.isSafeInteger(loaded.sizeBytes) ||
        loaded.sizeBytes < 1 ||
        loaded.sizeBytes > this.options.maxBytes
      ) {
        // Oversized values are still usable for this call after validation, but
        // retaining one must never defeat the cache's memory cap.
        return loaded.value;
      }
      const insertedAt = (this.options.now ?? Date.now)();
      this.entries.set(key, {
        ...loaded,
        expiresAt: insertedAt + this.options.ttlMs,
        lastUsedAt: insertedAt,
      });
      this.totalBytes += loaded.sizeBytes;
      this.pruneToLimits();
      return loaded.value;
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.totalBytes = 0;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key, entry);
    }
  }

  private pruneToLimits(): void {
    while (
      this.entries.size > this.options.maxEntries ||
      this.totalBytes > this.options.maxBytes
    ) {
      const oldest = [...this.entries.entries()].reduce((candidate, current) =>
        current[1].lastUsedAt < candidate[1].lastUsedAt ? current : candidate,
      );
      this.delete(oldest[0], oldest[1]);
    }
  }

  private delete(key: string, entry: { sizeBytes: number }): void {
    if (this.entries.delete(key)) this.totalBytes -= entry.sizeBytes;
  }
}

export function decisionSourceCacheKey(value: {
  deployment: string;
  storageId: string;
  sha256: string;
  benchmarkVersion: string;
}): string {
  // JSON encoding is unambiguous even if an input contains a separator.
  return JSON.stringify([
    value.deployment,
    value.storageId,
    value.sha256,
    value.benchmarkVersion,
  ]);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/** Preserve input order while keeping expensive storage reads below a hard
 * concurrency limit. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed) {
        const index = next++;
        if (index >= values.length) return;
        try {
          results[index] = await map(values[index], index);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    },
  );
  // Drain reads that were already in flight. No worker receives another item
  // after the first failure, and the caller sees that first failure only after
  // those bounded reads have settled.
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
