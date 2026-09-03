import { mapNatsPayloadToActivityEvent } from "../src/nats-bus-event-mapper";
import { NatsBusFieldMap } from "../src/nats-bus-config";

const BASE_MAP: NatsBusFieldMap = {
  employeeIdField: "agentId",
  activityField: "state",
};

function payload(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("mapNatsPayloadToActivityEvent", () => {
  it("maps a minimal payload using only the required fields", () => {
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "AVAILABLE" }),
      BASE_MAP,
      "tenant-1",
      1,
    );

    expect(event).toMatchObject({
      employeeId: "emp-1",
      currentActivity: "AVAILABLE",
    });
    expect(event?.sourceEventId).toBe("tenant-1:emp-1:AVAILABLE:1");
    expect(event?.activityStartedAt).toBeDefined();
  });

  it("coerces a numeric employee id to a string", () => {
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: 4711, state: "AVAILABLE" }),
      BASE_MAP,
      "tenant-1",
      1,
    );
    expect(event?.employeeId).toBe("4711");
  });

  it("translates the raw activity value through activityValueMap", () => {
    const map: NatsBusFieldMap = {
      ...BASE_MAP,
      activityValueMap: { AVAILABLE: "ready", AUX: "notReady" },
    };
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "AUX" }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.currentActivity).toBe("notReady");
  });

  it("passes an unmapped raw activity value through unchanged", () => {
    const map: NatsBusFieldMap = {
      ...BASE_MAP,
      activityValueMap: { AVAILABLE: "ready" },
    };
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "ON_BREAK" }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.currentActivity).toBe("ON_BREAK");
  });

  it("reads siteId/queueId when configured and present", () => {
    const map: NatsBusFieldMap = {
      ...BASE_MAP,
      siteIdField: "site",
      queueIdField: "queue",
    };
    const event = mapNatsPayloadToActivityEvent(
      payload({
        agentId: "emp-1",
        state: "AVAILABLE",
        site: "site-1",
        queue: "queue-1",
      }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.siteId).toBe("site-1");
    expect(event?.queueId).toBe("queue-1");
  });

  it("parses an ISO-8601 timestamp field", () => {
    const map: NatsBusFieldMap = { ...BASE_MAP, timestampField: "ts" };
    const event = mapNatsPayloadToActivityEvent(
      payload({
        agentId: "emp-1",
        state: "AVAILABLE",
        ts: "2026-01-15T10:00:00Z",
      }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.activityStartedAt).toBe("2026-01-15T10:00:00.000Z");
  });

  it("parses a unix-milliseconds timestamp field", () => {
    const map: NatsBusFieldMap = { ...BASE_MAP, timestampField: "ts" };
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "AVAILABLE", ts: 1768471200000 }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.activityStartedAt).toBe(
      new Date(1768471200000).toISOString(),
    );
  });

  it("parses a unix-seconds timestamp field", () => {
    const map: NatsBusFieldMap = { ...BASE_MAP, timestampField: "ts" };
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "AVAILABLE", ts: 1768471200 }),
      map,
      "tenant-1",
      1,
    );
    expect(event?.activityStartedAt).toBe(
      new Date(1768471200000).toISOString(),
    );
  });

  it("falls back to receipt time when timestampField is unset", () => {
    const before = Date.now();
    const event = mapNatsPayloadToActivityEvent(
      payload({ agentId: "emp-1", state: "AVAILABLE" }),
      BASE_MAP,
      "tenant-1",
      1,
    );
    const parsed = new Date(event?.activityStartedAt ?? 0).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
  });

  it("returns null for malformed JSON", () => {
    expect(
      mapNatsPayloadToActivityEvent(
        new TextEncoder().encode("{not json"),
        BASE_MAP,
        "tenant-1",
        1,
      ),
    ).toBeNull();
  });

  it("returns null for a JSON array payload", () => {
    expect(
      mapNatsPayloadToActivityEvent(
        payload([1, 2, 3]),
        BASE_MAP,
        "tenant-1",
        1,
      ),
    ).toBeNull();
  });

  it("returns null when the employeeIdField is missing", () => {
    expect(
      mapNatsPayloadToActivityEvent(
        payload({ state: "AVAILABLE" }),
        BASE_MAP,
        "tenant-1",
        1,
      ),
    ).toBeNull();
  });

  it("returns null when the activityField is missing", () => {
    expect(
      mapNatsPayloadToActivityEvent(
        payload({ agentId: "emp-1" }),
        BASE_MAP,
        "tenant-1",
        1,
      ),
    ).toBeNull();
  });
});
