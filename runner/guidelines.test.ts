import { describe, it, expect } from "bun:test";
import { getGuidelines } from "./models/guidelines.js";

describe("guidelines", () => {
  it("loads non-empty guidelines from markdown file", () => {
    const md = getGuidelines();
    expect(md.length).toBeGreaterThan(500);
  });

  it("contains known top-level sections", () => {
    const md = getGuidelines();
    expect(md).toContain("## Function guidelines");
    expect(md).toContain("## Schema guidelines");
    expect(md).toContain("## Query guidelines");
    expect(md).toContain("## Mutation guidelines");
    expect(md).toContain("## Action guidelines");
  });

  it("contains code examples", () => {
    const md = getGuidelines();
    expect(md).toContain("```typescript");
    expect(md).toContain("```ts");
  });

  it("documents typed env and nullability guidance", () => {
    const md = getGuidelines();
    expect(md).toContain("convex/convex.config.ts");
    expect(md).toContain('import { env } from "./_generated/server"');
    expect(md).toContain("v.optional(v.union(v.null(), v.string()))");
  });
});
