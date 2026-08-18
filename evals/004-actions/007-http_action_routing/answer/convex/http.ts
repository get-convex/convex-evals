import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// GET /getFoo endpoint
http.route({
  path: "/getFoo",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

// POST /postBar endpoint
http.route({
  path: "/postBar",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

// PUT /putBaz endpoint
http.route({
  path: "/putBaz",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

// GET /api/* wildcard endpoint
http.route({
  pathPrefix: "/api/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
});

export default http;
