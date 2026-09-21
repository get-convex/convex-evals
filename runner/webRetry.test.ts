import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { runEvalsForModel } from "./index";

const previous = { ...process.env };
afterEach(() => {
  process.env = { ...previous };
});

// The old server-tool retry path cannot filter content before the model sees it.
// Keep its low-level trace/SDK tests, but do not let real eval runs select it.
test.each(["0", "1"])(
  "unfiltered web runs are refused with reporting disabled=%s",
  async (disabled) => {
    delete process.env.CLIENT_WEB_TOOLS;
    process.env.OPENROUTER_API_KEY = "test";
    process.env.DISABLE_CONVEX_REPORTING = disabled;
    await rejects(
      runEvalsForModel({
        experiment: "no_guidelines_with_web",
        get model(): never {
          throw new Error("Model work began before validation");
        },
        tempdir: "unused",
      }),
      /require CLIENT_WEB_TOOLS=1/,
    );
    expect(process.env.CLIENT_WEB_TOOLS).toBeUndefined();
  },
);
