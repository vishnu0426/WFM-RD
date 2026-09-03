import { ActivityEvent } from "./activity-event-forwarder";
import { NatsBusFieldMap } from "./nats-bus-config";

/**
 * Parses one raw NATS message payload - assumed flat JSON, the common case
 * for a customer's own event bus - into this platform's `ActivityEvent`
 * shape, per a per-customer `NatsBusFieldMap`. A customer publishing
 * something other than JSON (protobuf, a delimited string, XML) needs a
 * bespoke mapper instead of this generic one, the same way this collector
 * already has a dedicated `csta-event-mapper.ts` for Avaya's own wire
 * format rather than trying to make one mapper cover every shape.
 *
 * Same never-throws contract `mapCstaEventXmlToActivityEvent` has - a
 * malformed payload, or one missing a required field, returns `null`
 * rather than taking down the subscription over one bad message.
 */
export function mapNatsPayloadToActivityEvent(
  raw: Uint8Array,
  fieldMap: NatsBusFieldMap,
  tenantId: string,
  sequence: number,
): ActivityEvent | null {
  let parsed: Record<string, unknown>;
  try {
    const text = Buffer.from(raw).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const employeeIdRaw = parsed[fieldMap.employeeIdField];
  if (typeof employeeIdRaw !== "string" && typeof employeeIdRaw !== "number") {
    return null;
  }
  const activityRaw = parsed[fieldMap.activityField];
  if (typeof activityRaw !== "string" && typeof activityRaw !== "number") {
    return null;
  }

  const employeeId = String(employeeIdRaw);
  const rawActivity = String(activityRaw);
  const activity = fieldMap.activityValueMap?.[rawActivity] ?? rawActivity;

  const activityStartedAt =
    parseTimestamp(
      fieldMap.timestampField ? parsed[fieldMap.timestampField] : undefined,
    ) ?? new Date().toISOString();
  const siteId = fieldMap.siteIdField
    ? asOptionalString(parsed[fieldMap.siteIdField])
    : undefined;
  const queueId = fieldMap.queueIdField
    ? asOptionalString(parsed[fieldMap.queueIdField])
    : undefined;

  return {
    sourceEventId: `${tenantId}:${employeeId}:${activity}:${sequence}`,
    employeeId,
    currentActivity: activity,
    activityStartedAt,
    siteId,
    queueId,
  };
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === "number") {
    // Accept both unix seconds and unix milliseconds - a 10-digit epoch
    // value is seconds until year 2286, a 13-digit one is already
    // milliseconds; treat anything under the millisecond range as seconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
