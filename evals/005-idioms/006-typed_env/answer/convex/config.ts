import { query, env } from "./_generated/server";

export const getSupportConfig = query({
  args: {},
  handler: async () => {
    return {
      supportEmail: env.SUPPORT_EMAIL ?? null,
      deploymentStage: env.DEPLOYMENT_STAGE ?? "dev",
      isConfigured: env.SUPPORT_EMAIL !== undefined,
    };
  },
});
