/**
 * Config for the "customer's own message bus" input mode - the README's
 * "Extending this pattern to a different on-prem ACD" section, now built.
 * A customer whose ACD/contact-center stack already publishes agent-state
 * events onto their own NATS bus, rather than speaking CSTA to an AES
 * server. Shares `config.ts`'s tenant/ingestion env vars unchanged
 * (AGNO_TENANT_ID/AGNO_INGESTION_BASE_URL/AGNO_INGESTION_SECRET) - only the
 * *source* side differs, so those three keep the exact same names rather
 * than being re-specified for this mode.
 *
 * `fieldMap` is deliberately data, not code, mirroring
 * `integration-hub-service`'s own `FieldMapping` entity shape
 * (sourceField -> targetField, plus a value-translation table for the
 * activity vocabulary): onboarding the *next* NATS-bus customer is a config
 * change, not a new TypeScript file, as long as their payload is flat JSON.
 * A customer whose payload needs real transformation logic (nested paths,
 * computed fields, a non-JSON wire format) still needs a bespoke mapper -
 * this covers the common case, not every case.
 */
export interface NatsBusFieldMap {
  /** Raw JSON key carrying the agent/employee identifier. Must already align with this platform's employeeId - there is no discovery/crosswalk call, the same "already-aligned IDs" posture `config.ts`'s own MONITORED_DEVICE_IDS and the cloud-side adapters all take. */
  employeeIdField: string;
  /** Raw JSON key carrying the agent's current activity/state. */
  activityField: string;
  /** Raw JSON key carrying the event's own timestamp (ISO-8601 string or unix-epoch number, ms or s). Omit to fall back to this collector's own receipt time, the same posture the CSTA mapper takes for a schema with no vendor timestamp. */
  timestampField?: string;
  /** Raw JSON key carrying the site id, if the customer's bus provides one. */
  siteIdField?: string;
  /** Raw JSON key carrying the queue id, if the customer's bus provides one. */
  queueIdField?: string;
  /** Raw activity value -> the string this collector forwards as `currentActivity`. Only meaningful if something downstream (e.g. intraday-service's adherence calculation) expects specific values - omit for a customer whose raw values can be forwarded as-is. Unmapped raw values pass through unchanged. */
  activityValueMap?: Record<string, string>;
}

/**
 * Which NATS delivery model the customer's bus actually uses. Confirmed
 * against a real customer bus (2026-09) that plain core-NATS `subscribe()`
 * is not a safe assumption: their agent-state events are only delivered
 * through JetStream streams (`CC_ACD_ESL_STREAM` etc.), consumed via a
 * named durable pull consumer another one of their own systems already
 * owns. Binding to that same durable name would steal a share of messages
 * from whatever already consumes it (JetStream fans a durable pull
 * consumer's messages out across all its pullers), so `jetstream` mode
 * deliberately never takes a consumer name from config - see
 * `nats-bus-collector.ts` for how it gets its own private ordered
 * consumer instead.
 */
export type NatsBusSource =
  | {
      mode: "core";
      /** Subject or wildcard pattern (e.g. `agent.state.>`) carrying agent-state events on the customer's bus. No default - every customer's bus uses its own subject naming; get this from them, don't guess it. */
      subject: string;
    }
  | {
      mode: "jetstream";
      /** The JetStream stream name carrying agent-state events (e.g. `CC_ACD_ESL_STREAM`). Get this from the customer - do not guess or reuse a consumer/stream name observed via discovery without confirming it's the right one. */
      stream: string;
      /**
       * The durable consumer name to bind to, if the customer's NATS
       * permissions require pulling from a specific pre-authorized name
       * rather than allowing this collector to create its own. Confirmed
       * against a real customer bus (2026-09) that this is a real
       * constraint, not a hypothetical: their `app` credential could
       * create/inspect an ephemeral ordered consumer, but pulling actual
       * messages from it hung indefinitely - NATS silently drops an
       * unauthorized pull request rather than erroring. The fix on their
       * side is a durable consumer dedicated to this integration (not the
       * one another of their systems already owns) with pull permission
       * explicitly granted to this credential; on our side, binding to it
       * by name instead of creating our own.
       *
       * Undefined (default) creates a private, self-healing ordered
       * consumer instead - only works if the credential is permitted to
       * create consumers, which is not a safe default assumption.
       */
      consumerName: string | undefined;
      /** Optional filter subject, if the stream carries more than agent-state events and needs narrowing. Ignored when `consumerName` is set - a durable consumer's filter was fixed by whoever created it. */
      filterSubject: string | undefined;
      /** `new` (default) delivers only events from the moment this collector connects - it does not replay the stream's full history, matching the posture of every other adapter in this package (forward live state, don't backfill). Ignored when `consumerName` is set - a durable consumer's deliver policy was fixed by whoever created it. */
      deliverPolicy: "all" | "new" | "last";
    };

export interface NatsBusCollectorConfig {
  tenantId: string;
  ingestionBaseUrl: string;
  ingestionSecret: string;
  /** The customer's own bus - not this platform's NATS. One or more `host:port` entries (comma-separated); each may be prefixed `nats://` or `tls://`, matching the `nats` client library's own server-URL parsing. */
  natsServers: string[];
  natsUser: string | undefined;
  natsPass: string | undefined;
  /**
   * `false` relaxes TLS certificate verification for this connection
   * (`tls: { rejectUnauthorized: false }`, applied by
   * `nats-bus-collector.ts` at connect time - confirmed against a real
   * customer's self-signed-cert NATS server that this is the option that
   * actually works; the `nats` client library ignores Node's process-wide
   * `NODE_TLS_REJECT_UNAUTHORIZED` env var for its own TLS socket). Defaults
   * to verifying (true); only set false for a bus already trusted for other
   * reasons (e.g. reachable only from inside a network you control), or if
   * the customer can supply a CA cert instead (the more correct fix,
   * currently not plumbed through - ask for one if this keeps mattering).
   */
  natsTlsRejectUnauthorized: boolean;
  source: NatsBusSource;
  fieldMap: NatsBusFieldMap;
}

export class MissingConfigError extends Error {
  constructor(key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = "MissingConfigError";
  }
}

export class InvalidFieldMapError extends Error {
  constructor(reason: string) {
    super(`CUSTOMER_NATS_FIELD_MAP is invalid: ${reason}`);
    this.name = "InvalidFieldMapError";
  }
}

export class InvalidDeliverPolicyError extends Error {
  constructor(value: string) {
    super(
      `CUSTOMER_NATS_DELIVER_POLICY must be "all", "new", or "last" (got "${value}")`,
    );
    this.name = "InvalidDeliverPolicyError";
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new MissingConfigError(key);
  }
  return value;
}

function parseFieldMap(raw: string): NatsBusFieldMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidFieldMapError(
      `not valid JSON (${(err as Error).message})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidFieldMapError("must be a JSON object");
  }
  const map = parsed as Record<string, unknown>;
  if (
    typeof map.employeeIdField !== "string" ||
    map.employeeIdField.length === 0
  ) {
    throw new InvalidFieldMapError(
      "employeeIdField is required and must be a non-empty string",
    );
  }
  if (typeof map.activityField !== "string" || map.activityField.length === 0) {
    throw new InvalidFieldMapError(
      "activityField is required and must be a non-empty string",
    );
  }
  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0;
  return {
    employeeIdField: map.employeeIdField,
    activityField: map.activityField,
    timestampField: isNonEmptyString(map.timestampField)
      ? map.timestampField
      : undefined,
    siteIdField: isNonEmptyString(map.siteIdField)
      ? map.siteIdField
      : undefined,
    queueIdField: isNonEmptyString(map.queueIdField)
      ? map.queueIdField
      : undefined,
    activityValueMap:
      typeof map.activityValueMap === "object" &&
      map.activityValueMap !== null &&
      !Array.isArray(map.activityValueMap)
        ? (map.activityValueMap as Record<string, string>)
        : undefined,
  };
}

export function loadNatsBusConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NatsBusCollectorConfig {
  const tenantId = requireEnv(env, "AGNO_TENANT_ID");
  const ingestionBaseUrl = requireEnv(env, "AGNO_INGESTION_BASE_URL").replace(
    /\/+$/,
    "",
  );
  const ingestionSecret = requireEnv(env, "AGNO_INGESTION_SECRET");

  const natsServers = requireEnv(env, "CUSTOMER_NATS_SERVERS")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (natsServers.length === 0) {
    throw new Error(
      "CUSTOMER_NATS_SERVERS must list at least one server (comma-separated)",
    );
  }

  const source = parseSource(env);
  const fieldMap = parseFieldMap(requireEnv(env, "CUSTOMER_NATS_FIELD_MAP"));

  return {
    tenantId,
    ingestionBaseUrl,
    ingestionSecret,
    natsServers,
    natsUser: env.CUSTOMER_NATS_USER,
    natsPass: env.CUSTOMER_NATS_PASS,
    natsTlsRejectUnauthorized:
      env.CUSTOMER_NATS_TLS_REJECT_UNAUTHORIZED !== "false",
    source,
    fieldMap,
  };
}

function parseSource(env: NodeJS.ProcessEnv): NatsBusSource {
  if (env.CUSTOMER_NATS_MODE === "jetstream") {
    const stream = requireEnv(env, "CUSTOMER_NATS_STREAM");
    const deliverPolicy = env.CUSTOMER_NATS_DELIVER_POLICY ?? "new";
    if (
      deliverPolicy !== "all" &&
      deliverPolicy !== "new" &&
      deliverPolicy !== "last"
    ) {
      throw new InvalidDeliverPolicyError(deliverPolicy);
    }
    return {
      mode: "jetstream",
      stream,
      consumerName: env.CUSTOMER_NATS_CONSUMER_NAME || undefined,
      filterSubject: env.CUSTOMER_NATS_FILTER_SUBJECT || undefined,
      deliverPolicy,
    };
  }
  return { mode: "core", subject: requireEnv(env, "CUSTOMER_NATS_SUBJECT") };
}
