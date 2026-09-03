/**
 * Every setting this collector needs, read once at startup from plain
 * environment variables - the customer's own ops team configures this
 * process (Docker env, systemd unit, etc.), so there's no config file
 * format or DB to design here, just a flat, documented env-var contract.
 */
export interface CollectorConfig {
  /** This platform's tenant id for the customer running this collector - goes in the ingestion URL path and into every forwarded event's HMAC scope. */
  tenantId: string;
  /** Base URL of intraday-service's public ingestion endpoint, e.g. `https://intraday.agno-wfm.example.com`. */
  ingestionBaseUrl: string;
  /** The HMAC signing secret issued for this tenant's ingestion credential (`IngestionCredentialsService` on the intraday-service side) - never the same value as any AES/local credential. */
  ingestionSecret: string;
  /** Hostname/IP of the customer's own Avaya Aura AES server - reachable from this process because it runs on the customer's own network, not from our cloud. */
  aesHost: string;
  aesPort: number;
  /** CSTA deviceIDs (agent extensions) to `MonitorStart` - tenant-supplied, same "already-aligned IDs, no discovery call" posture the cloud-side adapter uses. */
  monitoredDeviceIds: string[];
  /** Optional AES-specific credential placed in CSTA's `security` extension field - see `avaya-aura-collector.ts`'s own doc comment for why this is best-effort. */
  securityToken: string | undefined;
}

export class MissingConfigError extends Error {
  constructor(key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = "MissingConfigError";
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new MissingConfigError(key);
  }
  return value;
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CollectorConfig {
  const tenantId = requireEnv(env, "AGNO_TENANT_ID");
  const ingestionBaseUrl = requireEnv(env, "AGNO_INGESTION_BASE_URL").replace(
    /\/+$/,
    "",
  );
  const ingestionSecret = requireEnv(env, "AGNO_INGESTION_SECRET");
  const aesHost = requireEnv(env, "AES_HOST");

  const aesPortRaw = requireEnv(env, "AES_PORT");
  const aesPort = Number(aesPortRaw);
  if (!Number.isInteger(aesPort) || aesPort <= 0 || aesPort > 65535) {
    throw new Error(
      `AES_PORT must be a valid port number, got "${aesPortRaw}"`,
    );
  }

  const monitoredDeviceIds = requireEnv(env, "MONITORED_DEVICE_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (monitoredDeviceIds.length === 0) {
    throw new Error(
      "MONITORED_DEVICE_IDS must list at least one device id (comma-separated)",
    );
  }

  return {
    tenantId,
    ingestionBaseUrl,
    ingestionSecret,
    aesHost,
    aesPort,
    monitoredDeviceIds,
    securityToken: env.AES_SECURITY_TOKEN,
  };
}
