import { env, query } from "./_generated/server";

export const getDeploymentInfo = query({
  args: {},
  handler: async () => {
    return {
      siteUrl: env.CONVEX_SITE_URL,
      cloudUrl: env.CONVEX_CLOUD_URL,
      appName: env.PUBLIC_APP_NAME ?? null,
    };
  },
});
