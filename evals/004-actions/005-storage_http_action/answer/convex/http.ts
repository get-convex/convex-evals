import { httpRouter } from "convex/server";
import { httpAction, query } from "./_generated/server";
import { v } from "convex/values";

const http = httpRouter();

http.route({
  path: "/store",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Read the request body as bytes
    const body = await request.blob();

    // Store the file in Convex storage
    const storageId = await ctx.storage.store(body);

    // Get the public URL for the stored file
    const url = await ctx.storage.getUrl(storageId);

    if (!url) {
      return new Response(
        JSON.stringify({ error: "Failed to generate URL" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Return the storage ID and URL in JSON format
    return new Response(
      JSON.stringify({
        storageId: storageId,
        url: url,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }),
});

export const getSiteURL = query({
  args: {},
  handler: async (ctx) => {
    return process.env.CONVEX_SITE_URL!;
  },
});

export default http;