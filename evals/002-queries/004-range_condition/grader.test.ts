import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get sensor readings in range returns empty array when no readings exist", async () => {
  const now = Math.floor(Date.now() / 1000);
  const readings = await responseClient.query(
    anyApi.public.getSensorReadingsInRange,
    {
      sensorId: "sensor1",
      startTime: now - 3600, // 1 hour ago
      endTime: now,
    },
  );
  expect(readings).toEqual([]);
});

test("get sensor readings in range returns correctly filtered and sorted readings", async () => {
  const baseTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

  // Load test data with mix of sensors and timestamps
  const testReadings = [
    // Inside range for sensor1
    { sensorId: "sensor1", timestamp: baseTime + 0, value: 20.0 },
    { sensorId: "sensor1", timestamp: baseTime + 600, value: 21.0 }, // +10 min
    { sensorId: "sensor1", timestamp: baseTime + 1200, value: 22.0 }, // +20 min
    { sensorId: "sensor1", timestamp: baseTime + 1800, value: 23.0 }, // +30 min

    // Outside range for sensor1
    { sensorId: "sensor1", timestamp: baseTime - 600, value: 19.0 }, // -10 min
    { sensorId: "sensor1", timestamp: baseTime + 3600, value: 24.0 }, // +60 min

    // Different sensor, inside range
    { sensorId: "sensor2", timestamp: baseTime + 600, value: 25.0 },
  ];
  await addDocuments(responseAdminClient, "temperatures", testReadings);

  // Test basic range query
  const readings = await responseClient.query(
    anyApi.public.getSensorReadingsInRange,
    {
      sensorId: "sensor1",
      startTime: baseTime,
      endTime: baseTime + 1800,
    },
  );

  // Should return readings within range
  expect(readings).toHaveLength(4);

  // Should be sorted by timestamp ascending
  for (let i = 0; i < readings.length - 1; i++) {
    expect(readings[i].timestamp).toBeLessThan(readings[i + 1].timestamp);
  }

  // Verify all fields are present and correct
  for (const reading of readings) {
    expect(reading).toHaveProperty("_id");
    expect(reading).toHaveProperty("_creationTime");
    expect(reading).toHaveProperty("sensorId", "sensor1");
    expect(reading).toHaveProperty("timestamp");
    expect(reading).toHaveProperty("value");
    expect(reading.timestamp).toBeGreaterThanOrEqual(baseTime);
    expect(reading.timestamp).toBeLessThanOrEqual(baseTime + 1800);
  }

  // Test different sensor
  const sensor2Readings = await responseClient.query(
    anyApi.public.getSensorReadingsInRange,
    {
      sensorId: "sensor2",
      startTime: baseTime,
      endTime: baseTime + 1800,
    },
  );
  expect(sensor2Readings).toHaveLength(1);
  expect(sensor2Readings[0].value).toBe(25.0);

  // Test smaller time range
  const shortRangeReadings = await responseClient.query(
    anyApi.public.getSensorReadingsInRange,
    {
      sensorId: "sensor1",
      startTime: baseTime + 500,
      endTime: baseTime + 700,
    },
  );
  expect(shortRangeReadings).toHaveLength(1);
  expect(shortRangeReadings[0].value).toBe(21.0);
});
