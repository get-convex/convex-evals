import { once } from "node:events";
import { connect } from "node:net";
import { expect, test } from "vitest";
import { startHttpFixture } from "./httpFixture";

test("teardown closes a connection with an unfinished next request", async () => {
  const fixture = await startHttpFixture();
  const socket = connect(Number(new URL(fixture.baseUrl).port), "127.0.0.1");
  // Teardown can reset the client's unfinished request.
  socket.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, "connect");
    const response = once(socket, "data");
    // One successful request proves the server accepted the connection. The
    // pipelined partial request keeps it active during server.close().
    socket.write(
      "GET /json HTTP/1.1\r\nHost: localhost\r\n\r\n" +
        "GET /json HTTP/1.1\r\nHost: localhost\r\n",
    );
    const [chunk] = await response;
    expect(String(chunk)).toContain("200 OK");
    await Promise.race([
      fixture.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture teardown stalled")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
});
