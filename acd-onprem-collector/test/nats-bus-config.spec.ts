import {
  InvalidDeliverPolicyError,
  InvalidFieldMapError,
  loadNatsBusConfigFromEnv,
  MissingConfigError,
} from "../src/nats-bus-config";

const VALID_FIELD_MAP = JSON.stringify({
  employeeIdField: "agentId",
  activityField: "state",
});

const VALID_ENV = {
  AGNO_TENANT_ID: "t1",
  AGNO_INGESTION_BASE_URL: "https://intraday.example.com/",
  AGNO_INGESTION_SECRET: "secret",
  CUSTOMER_NATS_SERVERS: "nats://192.168.9.81:4222",
  CUSTOMER_NATS_SUBJECT: "agent.state.>",
  CUSTOMER_NATS_FIELD_MAP: VALID_FIELD_MAP,
};

describe("loadNatsBusConfigFromEnv", () => {
  it("parses a fully valid environment", () => {
    const config = loadNatsBusConfigFromEnv(VALID_ENV);

    expect(config).toEqual({
      tenantId: "t1",
      ingestionBaseUrl: "https://intraday.example.com",
      ingestionSecret: "secret",
      natsServers: ["nats://192.168.9.81:4222"],
      natsUser: undefined,
      natsPass: undefined,
      natsTlsRejectUnauthorized: true,
      source: { mode: "core", subject: "agent.state.>" },
      fieldMap: {
        employeeIdField: "agentId",
        activityField: "state",
        timestampField: undefined,
        siteIdField: undefined,
        queueIdField: undefined,
        activityValueMap: undefined,
      },
    });
  });

  it("splits and trims a comma-separated CUSTOMER_NATS_SERVERS list", () => {
    const config = loadNatsBusConfigFromEnv({
      ...VALID_ENV,
      CUSTOMER_NATS_SERVERS: " nats://a:4222 , nats://b:4222",
    });
    expect(config.natsServers).toEqual(["nats://a:4222", "nats://b:4222"]);
  });

  it("reads optional user/pass", () => {
    const config = loadNatsBusConfigFromEnv({
      ...VALID_ENV,
      CUSTOMER_NATS_USER: "app",
      CUSTOMER_NATS_PASS: "Admin@123",
    });
    expect(config.natsUser).toBe("app");
    expect(config.natsPass).toBe("Admin@123");
  });

  it("defaults natsTlsRejectUnauthorized to true, and only false disables it", () => {
    expect(loadNatsBusConfigFromEnv(VALID_ENV).natsTlsRejectUnauthorized).toBe(
      true,
    );
    expect(
      loadNatsBusConfigFromEnv({
        ...VALID_ENV,
        CUSTOMER_NATS_TLS_REJECT_UNAUTHORIZED: "false",
      }).natsTlsRejectUnauthorized,
    ).toBe(false);
    expect(
      loadNatsBusConfigFromEnv({
        ...VALID_ENV,
        CUSTOMER_NATS_TLS_REJECT_UNAUTHORIZED: "anything-else",
      }).natsTlsRejectUnauthorized,
    ).toBe(true);
  });

  it("parses the optional field-map keys when present", () => {
    const fieldMap = JSON.stringify({
      employeeIdField: "agentId",
      activityField: "state",
      timestampField: "ts",
      siteIdField: "site",
      queueIdField: "queue",
      activityValueMap: { AVAILABLE: "ready", AUX: "notReady" },
    });
    const config = loadNatsBusConfigFromEnv({
      ...VALID_ENV,
      CUSTOMER_NATS_FIELD_MAP: fieldMap,
    });
    expect(config.fieldMap).toEqual({
      employeeIdField: "agentId",
      activityField: "state",
      timestampField: "ts",
      siteIdField: "site",
      queueIdField: "queue",
      activityValueMap: { AVAILABLE: "ready", AUX: "notReady" },
    });
  });

  it.each([
    "AGNO_TENANT_ID",
    "AGNO_INGESTION_BASE_URL",
    "AGNO_INGESTION_SECRET",
    "CUSTOMER_NATS_SERVERS",
    "CUSTOMER_NATS_SUBJECT",
    "CUSTOMER_NATS_FIELD_MAP",
  ])("throws MissingConfigError when %s is absent", (key) => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string>)[key];
    expect(() => loadNatsBusConfigFromEnv(env)).toThrow(MissingConfigError);
  });

  it("rejects CUSTOMER_NATS_SERVERS that is only whitespace/commas", () => {
    expect(() =>
      loadNatsBusConfigFromEnv({ ...VALID_ENV, CUSTOMER_NATS_SERVERS: " , ," }),
    ).toThrow(/CUSTOMER_NATS_SERVERS/);
  });

  it("rejects a CUSTOMER_NATS_FIELD_MAP that is not valid JSON", () => {
    expect(() =>
      loadNatsBusConfigFromEnv({
        ...VALID_ENV,
        CUSTOMER_NATS_FIELD_MAP: "{not json",
      }),
    ).toThrow(InvalidFieldMapError);
  });

  it("rejects a CUSTOMER_NATS_FIELD_MAP missing employeeIdField", () => {
    expect(() =>
      loadNatsBusConfigFromEnv({
        ...VALID_ENV,
        CUSTOMER_NATS_FIELD_MAP: JSON.stringify({ activityField: "state" }),
      }),
    ).toThrow(InvalidFieldMapError);
  });

  it("rejects a CUSTOMER_NATS_FIELD_MAP missing activityField", () => {
    expect(() =>
      loadNatsBusConfigFromEnv({
        ...VALID_ENV,
        CUSTOMER_NATS_FIELD_MAP: JSON.stringify({ employeeIdField: "agentId" }),
      }),
    ).toThrow(InvalidFieldMapError);
  });

  describe("jetstream mode", () => {
    const JS_ENV = {
      ...VALID_ENV,
      CUSTOMER_NATS_MODE: "jetstream",
      CUSTOMER_NATS_STREAM: "CC_ACD_ESL_STREAM",
    };

    it("parses a valid jetstream environment, defaulting deliverPolicy to new", () => {
      const config = loadNatsBusConfigFromEnv(JS_ENV);
      expect(config.source).toEqual({
        mode: "jetstream",
        stream: "CC_ACD_ESL_STREAM",
        consumerName: undefined,
        filterSubject: undefined,
        deliverPolicy: "new",
      });
    });

    it("reads an optional filter subject and deliver policy", () => {
      const config = loadNatsBusConfigFromEnv({
        ...JS_ENV,
        CUSTOMER_NATS_FILTER_SUBJECT: "cc.acd.esl.voice.>",
        CUSTOMER_NATS_DELIVER_POLICY: "all",
      });
      expect(config.source).toEqual({
        mode: "jetstream",
        stream: "CC_ACD_ESL_STREAM",
        consumerName: undefined,
        filterSubject: "cc.acd.esl.voice.>",
        deliverPolicy: "all",
      });
    });

    it("reads an optional durable consumer name to bind to", () => {
      const config = loadNatsBusConfigFromEnv({
        ...JS_ENV,
        CUSTOMER_NATS_CONSUMER_NAME: "AGNO_WFM_COLLECTOR",
      });
      expect(config.source).toMatchObject({
        consumerName: "AGNO_WFM_COLLECTOR",
      });
    });

    it("does not require CUSTOMER_NATS_SUBJECT in jetstream mode", () => {
      const env = { ...JS_ENV } as Record<string, string>;
      delete env.CUSTOMER_NATS_SUBJECT;
      expect(() => loadNatsBusConfigFromEnv(env)).not.toThrow();
    });

    it("throws MissingConfigError when CUSTOMER_NATS_STREAM is absent", () => {
      const env = { ...JS_ENV } as Record<string, string>;
      delete env.CUSTOMER_NATS_STREAM;
      expect(() => loadNatsBusConfigFromEnv(env)).toThrow(MissingConfigError);
    });

    it("rejects an invalid CUSTOMER_NATS_DELIVER_POLICY", () => {
      expect(() =>
        loadNatsBusConfigFromEnv({
          ...JS_ENV,
          CUSTOMER_NATS_DELIVER_POLICY: "sometimes",
        }),
      ).toThrow(InvalidDeliverPolicyError);
    });
  });
});
