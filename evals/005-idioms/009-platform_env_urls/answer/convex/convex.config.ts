import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    // Only the app's own variable is declared here. CONVEX_SITE_URL and
    // CONVEX_CLOUD_URL are provided by the platform and already typed on `env`.
    PUBLIC_APP_NAME: v.optional(v.string()),
  },
});
