import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";

test("create and read location", async () => {
  // Test successful creation
  const locationId = await responseClient.mutation(
    api.public.createLocation,
    {
      name: "San Francisco",
      latitude: 37.7749,
      longitude: -122.4194,
    },
  );
  expect(locationId).toBeDefined();

  // Test reading the created location
  const location = await responseClient.query(api.public.readLocation, {
    id: locationId,
  });
  expect(location).toEqual({
    _id: locationId,
    _creationTime: expect.any(Number),
    name: "San Francisco",
    latitude: 37.7749,
    longitude: -122.4194,
  });

  // Test invalid arguments
  await expect(
    responseClient.mutation(api.public.createLocation, {
      name: "Invalid",
      latitude: "not a number" as unknown as number,
      longitude: -122.4194,
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("update location", async () => {
  // Create a test location
  const locationId = await responseClient.mutation(
    api.public.createLocation,
    {
      name: "New York",
      latitude: 40.7128,
      longitude: -74.006,
    },
  );

  // Test full update
  await responseClient.mutation(api.public.updateLocation, {
    id: locationId,
    name: "Manhattan",
    latitude: 40.7831,
    longitude: -73.9712,
  });

  // Verify update
  const updated = await responseClient.query(api.public.readLocation, {
    id: locationId,
  });
  expect(updated).toEqual({
    _id: locationId,
    _creationTime: expect.any(Number),
    name: "Manhattan",
    latitude: 40.7831,
    longitude: -73.9712,
  });
});

test("patch location", async () => {
  // Create a test location
  const locationId = await responseClient.mutation(
    api.public.createLocation,
    {
      name: "Seattle",
      latitude: 47.6062,
      longitude: -122.3321,
    },
  );

  // Test partial update - only name
  await responseClient.mutation(api.public.patchLocation, {
    id: locationId,
    name: "Downtown Seattle",
  });

  // Verify only name changed
  let patched = await responseClient.query(api.public.readLocation, {
    id: locationId,
  });
  expect(patched).toEqual({
    _id: locationId,
    _creationTime: expect.any(Number),
    name: "Downtown Seattle",
    latitude: 47.6062,
    longitude: -122.3321,
  });
});

test("delete location", async () => {
  // Create a test location
  const locationId = await responseClient.mutation(
    api.public.createLocation,
    {
      name: "Chicago",
      latitude: 41.8781,
      longitude: -87.6298,
    },
  );

  // Verify it exists
  const location = await responseClient.query(api.public.readLocation, {
    id: locationId,
  });
  expect(location).toBeDefined();

  // Delete it
  await responseClient.mutation(api.public.deleteLocation, {
    id: locationId,
  });

  // Verify it's gone
  const deleted = await responseClient.query(api.public.readLocation, {
    id: locationId,
  });
  expect(deleted).toBeNull();
});
