import { afterAll, beforeAll, expect, test } from "vitest";
import { responseClient } from "../../../grader";
import {
  type HttpFixture,
  startHttpFixture,
} from "../../../grader/httpFixture";
import { api } from "./answer/convex/_generated/api";

let fixture: HttpFixture;

beforeAll(async () => {
  fixture = await startHttpFixture();
});

afterAll(async () => {
  await fixture.close();
});

async function fetchFixture(): Promise<unknown> {
  return await responseClient.action(api.index.fetchJson, {
    url: `${fixture.baseUrl}/get`,
  });
}

test("fetches JSON from the supplied URL", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response: any = await fetchFixture();

  // Verify response structure
  expect(response).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.url).toBe(`${fixture.baseUrl}/get`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toBeDefined();
});

test("response contains the fixture fields", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response: any = await fetchFixture();

  // Check the response came through the real HTTP fixture.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.origin).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toHaveProperty("Host");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toHaveProperty("Accept");
});

test("returns valid JSON", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response: any = await fetchFixture();

  // Verify we can stringify and parse the response
  const jsonString = JSON.stringify(response);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  expect(() => JSON.parse(jsonString)).not.toThrow();
});
