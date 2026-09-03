import { mapCstaEventXmlToActivityEvent } from "../src/csta-event-mapper";

const NS = "http://www.ecma-international.org/standards/ecma-323/csta/ed6";

describe("mapCstaEventXmlToActivityEvent", () => {
  it('maps AgentReadyEvent to activity "ready"', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice><agentID>emp-1</agentID></AgentReadyEvent>`;

    const event = mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1");

    expect(event).toMatchObject({
      employeeId: "emp-1",
      currentActivity: "ready",
    });
    expect(event?.sourceEventId).toBe("tenant-1:emp-1:ready:1");
  });

  it.each([
    ["AgentNotReadyEvent", "notReady"],
    ["AgentBusyEvent", "busy"],
    ["AgentWorkingAfterCallEvent", "workingAfterCall"],
    ["AgentLoggedOnEvent", "loggedOn"],
    ["AgentLoggedOffEvent", "loggedOff"],
  ])("maps %s to activity %s", (tag, activity) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><${tag} xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice></${tag}>`;

    const event = mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1");

    expect(event?.currentActivity).toBe(activity);
  });

  it('falls back to the device identifier as employeeId when agentID is absent (minOccurs="0")', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice></AgentReadyEvent>`;

    const event = mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1");

    expect(event?.employeeId).toBe("4711");
  });

  it("returns null for an event type not in the six-event agent-state table", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><SomeOtherCstaEvent xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice></SomeOtherCstaEvent>`;

    expect(mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1")).toBeNull();
  });

  it("returns null when agentDevice.deviceIdentifier is missing (the one field every event requires)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${NS}"><agentID>emp-1</agentID></AgentReadyEvent>`;

    expect(mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1")).toBeNull();
  });

  it("returns null (never throws) for unparseable XML", () => {
    expect(
      mapCstaEventXmlToActivityEvent("<not-xml", 1, "tenant-1"),
    ).toBeNull();
  });

  it("leaves siteId/queueId undefined (no CSTA agent-state event schema carries either)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice></AgentReadyEvent>`;

    const event = mapCstaEventXmlToActivityEvent(xml, 1, "tenant-1");

    expect(event?.siteId).toBeUndefined();
    expect(event?.queueId).toBeUndefined();
  });
});
