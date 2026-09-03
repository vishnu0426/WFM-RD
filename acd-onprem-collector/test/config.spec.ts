import { loadConfigFromEnv, MissingConfigError } from "../src/config";

const VALID_ENV = {
  AGNO_TENANT_ID: "t1",
  AGNO_INGESTION_BASE_URL: "https://intraday.example.com/",
  AGNO_INGESTION_SECRET: "secret",
  AES_HOST: "aes.internal.example.com",
  AES_PORT: "4721",
  MONITORED_DEVICE_IDS: "1001, 1002 ,1003",
};

describe("loadConfigFromEnv", () => {
  it("parses a fully valid environment", () => {
    const config = loadConfigFromEnv(VALID_ENV);

    expect(config).toEqual({
      tenantId: "t1",
      ingestionBaseUrl: "https://intraday.example.com",
      ingestionSecret: "secret",
      aesHost: "aes.internal.example.com",
      aesPort: 4721,
      monitoredDeviceIds: ["1001", "1002", "1003"],
      securityToken: undefined,
    });
  });

  it("strips a trailing slash from the ingestion base URL", () => {
    expect(loadConfigFromEnv(VALID_ENV).ingestionBaseUrl).toBe(
      "https://intraday.example.com",
    );
  });

  it("trims and filters blank entries out of MONITORED_DEVICE_IDS", () => {
    const config = loadConfigFromEnv({
      ...VALID_ENV,
      MONITORED_DEVICE_IDS: " 1001,,1002 ,",
    });
    expect(config.monitoredDeviceIds).toEqual(["1001", "1002"]);
  });

  it("reads the optional AES_SECURITY_TOKEN when present", () => {
    const config = loadConfigFromEnv({
      ...VALID_ENV,
      AES_SECURITY_TOKEN: "tok",
    });
    expect(config.securityToken).toBe("tok");
  });

  it.each([
    "AGNO_TENANT_ID",
    "AGNO_INGESTION_BASE_URL",
    "AGNO_INGESTION_SECRET",
    "AES_HOST",
    "AES_PORT",
    "MONITORED_DEVICE_IDS",
  ])("throws MissingConfigError when %s is absent", (key) => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string>)[key];
    expect(() => loadConfigFromEnv(env)).toThrow(MissingConfigError);
  });

  it("rejects a non-numeric AES_PORT", () => {
    expect(() =>
      loadConfigFromEnv({ ...VALID_ENV, AES_PORT: "not-a-port" }),
    ).toThrow(/AES_PORT/);
  });

  it("rejects an out-of-range AES_PORT", () => {
    expect(() =>
      loadConfigFromEnv({ ...VALID_ENV, AES_PORT: "99999" }),
    ).toThrow(/AES_PORT/);
  });

  it("rejects MONITORED_DEVICE_IDS that is only whitespace/commas", () => {
    expect(() =>
      loadConfigFromEnv({ ...VALID_ENV, MONITORED_DEVICE_IDS: " , ," }),
    ).toThrow(/MONITORED_DEVICE_IDS/);
  });
});
