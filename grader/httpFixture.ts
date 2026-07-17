import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type HttpFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

/**
 * Starts a loopback HTTP server for action evals.
 *
 * These evals are about Convex action behavior, not httpbin.org availability.
 * Keeping the fixture local still exercises a real fetch from the separate
 * Convex backend process while making the response fast and deterministic.
 */
export async function startHttpFixture(): Promise<HttpFixture> {
  const server = createServer((request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);

    response.setHeader("content-type", "application/json");

    if (url.pathname === "/status/500") {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "fixture failure" }));
      return;
    }

    if (url.pathname === "/json") {
      response.end(
        JSON.stringify({
          slideshow: {
            author: "Convex eval fixture",
            date: "2026-07-17",
            slides: [{ title: "Deterministic HTTP" }],
          },
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        args: Object.fromEntries(url.searchParams),
        headers: {
          Accept: request.headers.accept ?? "*/*",
          Host: host,
        },
        origin: request.socket.remoteAddress ?? "127.0.0.1",
        url: url.toString(),
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}
