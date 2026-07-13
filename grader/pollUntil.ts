/**
 * Polls a predicate until it returns true, checking immediately and then on an
 * interval. Throws a descriptive error if the predicate is still false after
 * `timeoutMs`. Use this in graders instead of fixed sleeps when waiting on
 * scheduled functions or other asynchronous backend work.
 */
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const { timeoutMs, intervalMs } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil: condition not met within ${timeoutMs}ms (polled every ${intervalMs}ms)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
