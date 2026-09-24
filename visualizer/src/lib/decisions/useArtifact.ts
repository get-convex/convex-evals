import { useEffect, useMemo, useState } from "react";

// A small client cache shares immutable source banks between runs. Individual
// question artifacts load only when opened, never in one request per sidebar row.
const cache = new Map<string, Promise<unknown>>();
function load(url: string): Promise<unknown> {
  const existing = cache.get(url);
  if (existing) return existing;
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(`Evidence request failed (${response.status}).`);
      // Convex returns compressed snapshots with Content-Encoding; fetch decodes it.
      return response.json() as Promise<unknown>;
    })
    .catch((error) => {
      cache.delete(url);
      throw error;
    });
  if (cache.size >= 12) cache.delete(cache.keys().next().value!);
  cache.set(url, promise);
  return promise;
}
export function useArtifact<T>(
  url: string | null | undefined,
  parse: (value: unknown) => T,
) {
  const [state, setState] = useState<{
    url: string;
    data?: unknown;
    error?: string;
  }>();
  useEffect(() => {
    if (!url) return;
    let active = true;
    load(url).then(
      (data) => {
        if (active) setState({ url, data });
      },
      (error) => {
        if (active)
          setState({
            url,
            error:
              error instanceof Error
                ? error.message
                : "Could not load evidence.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [url]);
  return useMemo(() => {
    if (!url) return { error: "This evidence file is unavailable." };
    if (state?.url !== url) return {};
    if (state.error) return { error: state.error };
    try {
      return { data: parse(state.data) };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Could not read evidence.",
      };
    }
  }, [url, state, parse]);
}
