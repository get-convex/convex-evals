import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  responseAdminClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

async function getStreamURL(): Promise<string> {
  const baseUrl = await responseAdminClient.query(api.http.getSiteURL, {});
  return `${baseUrl}/stream`;
}

async function collectStreamMessages(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        messages.push(line.slice(6));
      }
    }
  }

  return messages;
}

test("streams line lengths correctly", async () => {
  const input = "hello\nworld\ntest";
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");

  const messages = await collectStreamMessages(response);
  const expected = [
    '{"lineLength": 5}',
    '{"lineLength": 5}',
    '{"lineLength": 4}',
  ];

  expect(messages).toEqual(expected);
});

test("handles empty lines", async () => {
  const input = "first\n\nlast";
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  const messages = await collectStreamMessages(response);
  const expected = [
    '{"lineLength": 5}',
    '{"lineLength": 4}',
  ];

  expect(messages).toEqual(expected);
});

test("handles single line input", async () => {
  const input = "single line test";
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  const messages = await collectStreamMessages(response);
  expect(messages).toEqual(['{"lineLength": 15}']);
});

test("handles large input", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`.repeat(10));
  const input = lines.join('\n');
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  const messages = await collectStreamMessages(response);
  expect(messages).toHaveLength(100);

  // Verify each message format
  for (const message of messages) {
    expect(message).toMatch(/^{"lineLength": \d+}$/);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed = JSON.parse(message);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(parsed.lineLength).toBeTypeOf("number");
  }
});

test("rejects non-POST requests", async () => {
  const url = await getStreamURL();
  const methods = ["GET", "PUT", "DELETE", "PATCH"];

  for (const method of methods) {
    const response = await fetch(url, { method });
    expect(response.status).toBe(404);
  }
});

test("handles special characters", async () => {
  const input = "special chars: !@#$%^&*()\némoji: 👋🌍\nunicode: 你好";
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  const messages = await collectStreamMessages(response);
  const expected = [
    '{"lineLength": 24}',
    '{"lineLength": 11}',
    '{"lineLength": 11}',
  ];

  expect(messages).toEqual(expected);
});

test("handles very long lines", async () => {
  const longLine = "x".repeat(10000);
  const input = `short line\n${longLine}\nfinal line`;
  const url = await getStreamURL();

  const response = await fetch(url, {
    method: "POST",
    body: input,
  });

  const messages = await collectStreamMessages(response);
  expect(messages).toHaveLength(3);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const parsedMiddle = JSON.parse(messages[1]);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(parsedMiddle.lineLength).toBe(10000);
});