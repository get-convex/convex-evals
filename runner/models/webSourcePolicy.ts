/** Versioned so a saved trace identifies which contamination filter it used. */
export const WEB_SOURCE_POLICY = "exclude-known-benchmark-sources-v1";

function normalize(value: string): string {
  // Catch encoded paths and URLs wrapped by mirrors/reader services. Stop after
  // a bounded number of passes; malformed escapes must not disable filtering.
  for (let i = 0; i < 4; i++) {
    const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    if (decoded === value) break;
    value = decoded;
  }
  return value.toLowerCase();
}

export function benchmarkSourceReason(value: string): string | undefined {
  const normalized = normalize(value);
  // Applies across hosts: GitHub, raw URLs, CDNs, forks and named mirrors.
  if (/convex[\s_-]+evals\b/.test(normalized))
    return "Known Convex benchmark source";
  // The public evals article includes this task's expected implementation.
  // Also catch copies which omit the original title or repository URL.
  if (
    [
      "emptypublicquery",
      "emptypublicmutation",
      "emptyprivatequery",
      "emptyprivatemutation",
    ].every((name) => normalized.includes(name))
  )
    return "Known benchmark example content";
  return undefined;
}

export function webSourceUrlReason(value: string): string | undefined {
  const source = benchmarkSourceReason(value);
  if (source) return source;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return "Expected a public HTTP(S) URL without credentials";
  } catch {
    return "Invalid URL";
  }
  return undefined;
}
