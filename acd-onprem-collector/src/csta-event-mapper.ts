import { XMLParser } from "fast-xml-parser";
import { ActivityEvent } from "./activity-event-forwarder";

/** The six real, schema-verified CSTA agent-state events (ECMA-323 §20.2) - CSTA models each transition as its own event type, not one event with a `state` enum. Same table `integration-hub-service`'s cloud-side `AvayaAuraAdapter` uses. */
export const AGENT_EVENT_ACTIVITY: Record<string, string> = {
  AgentReadyEvent: "ready",
  AgentNotReadyEvent: "notReady",
  AgentBusyEvent: "busy",
  AgentWorkingAfterCallEvent: "workingAfterCall",
  AgentLoggedOnEvent: "loggedOn",
  AgentLoggedOffEvent: "loggedOff",
};

interface AgentEventBody {
  agentDevice?: { deviceIdentifier?: string };
  agentID?: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  // Without this, fast-xml-parser surfaces the `<?xml ... ?>` prolog as its
  // own leading `"?xml"` key, which would win `Object.keys(parsed)[0]`
  // below over the real root element (e.g. `AgentReadyEvent`).
  ignoreDeclaration: true,
});

/**
 * Parses one CSTA-XML event frame body into this platform's `ActivityEvent`
 * shape - adapted from `integration-hub-service`'s cloud-side
 * `AvayaAuraAdapter.handleEventFrame`, minus the tenant-configurable
 * field-mapping layer (`FieldMappingsService`/`applyFieldMappings`): this
 * collector serves exactly one tenant's own AES, so there's no per-tenant
 * mapping to select between, unlike the cloud service which multiplexes
 * many tenants' connectors through shared code.
 *
 * Same two disclosed gaps the cloud-side adapter has, inherited because
 * they're properties of the CSTA schema itself, not of where this code
 * runs: none of the six event schemas carry a queue/site id (`queueId`/
 * `siteId` are always left `undefined`), and none carry a vendor event
 * timestamp (`activityStartedAt` is this collector's own receipt time).
 *
 * Returns `null` for a frame that fails to parse, maps to no known event
 * type, or is missing the one field every one of these six events actually
 * requires (`agentDevice.deviceIdentifier`) - never throws, so one
 * malformed frame can't take down the connection.
 */
export function mapCstaEventXmlToActivityEvent(
  xml: string,
  sequence: number,
  tenantId: string,
): ActivityEvent | null {
  let parsed: Record<string, AgentEventBody>;
  try {
    parsed = xmlParser.parse(xml) as Record<string, AgentEventBody>;
  } catch {
    return null;
  }

  const rootTag = Object.keys(parsed)[0];
  const activity = rootTag ? AGENT_EVENT_ACTIVITY[rootTag] : undefined;
  if (!activity) {
    return null;
  }

  const body = parsed[rootTag];
  const agentDeviceId = body.agentDevice?.deviceIdentifier;
  if (!agentDeviceId) {
    return null;
  }
  // agentID is `minOccurs="0"` in the real schema - device ID is the one
  // field every one of these six events actually requires.
  const employeeId = body.agentID ?? agentDeviceId;

  return {
    sourceEventId: `${tenantId}:${employeeId}:${activity}:${sequence}`,
    employeeId,
    currentActivity: activity,
    activityStartedAt: new Date().toISOString(),
  };
}
