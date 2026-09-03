import { Server, Socket, createServer } from "node:net";
import {
  AvayaAuraCollector,
  CollectorLogger,
} from "../src/avaya-aura-collector";
import { CollectorConfig } from "../src/config";
import {
  CSTA_EVENT_INVOKE_ID,
  CstaFrameReader,
  encodeCstaFrame,
} from "../src/csta-xml-frame";

const NS = "http://www.ecma-international.org/standards/ecma-323/csta/ed6";

function waitUntil<T>(
  check: () => T | undefined,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const value = check();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("waitUntil timed out"));
        return;
      }
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

const silentLogger: CollectorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Same posture `integration-hub-service/test/integration/avaya-aura-adapter.spec.ts`
 * takes: a real local TCP server speaking real ECMA-323 Annex J framing
 * and the schema-verified `RequestSystemStatus`/`MonitorStart` service
 * shapes, using the same `CstaFrameReader`/`encodeCstaFrame` this
 * collector itself uses - proof this collector's *encoding* matches the
 * public standard, not proof it matches a real AES (see
 * `avaya-aura-collector.ts`'s own doc comment for what remains
 * unverified). No Postgres/Vault/HTTP here - `ActivityEventForwarder` is
 * replaced with a stub so this stays a fast unit-level test of the CSTA
 * side only.
 */
describe("AvayaAuraCollector", () => {
  let aesServer: Server;
  let aesPort: number;
  let aesSocket: Socket | undefined;
  let receivedSecurityHex: string | undefined;
  const receivedMonitorDeviceIds: string[] = [];

  beforeEach(async () => {
    receivedSecurityHex = undefined;
    receivedMonitorDeviceIds.length = 0;
    aesServer = createServer((socket) => {
      aesSocket = socket;
      const reader = new CstaFrameReader();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) {
          if (frame.xml.includes("<RequestSystemStatus")) {
            const match = /<security>([0-9a-f]*)<\/security>/.exec(frame.xml);
            receivedSecurityHex = match?.[1];
            socket.write(
              encodeCstaFrame(
                frame.invokeId,
                `<?xml version="1.0" encoding="UTF-8"?><RequestSystemStatusResponse xmlns="${NS}"/>`,
              ),
            );
            continue;
          }
          if (frame.xml.includes("<MonitorStart")) {
            const match = /<deviceObject>([^<]*)<\/deviceObject>/.exec(
              frame.xml,
            );
            const deviceId = match?.[1] ?? "";
            receivedMonitorDeviceIds.push(deviceId);
            socket.write(
              encodeCstaFrame(
                frame.invokeId,
                `<?xml version="1.0" encoding="UTF-8"?><MonitorStartResponse xmlns="${NS}"><monitorCrossRefID>xref-${deviceId}</monitorCrossRefID></MonitorStartResponse>`,
              ),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      aesServer.listen(0, "127.0.0.1", resolve),
    );
    const address = aesServer.address();
    if (!address || typeof address === "string")
      throw new Error("failed to start fake AES server");
    aesPort = address.port;
  });

  afterEach(async () => {
    aesSocket?.destroy();
    await new Promise<void>((resolve) => aesServer.close(() => resolve()));
  });

  function makeConfig(
    overrides: Partial<CollectorConfig> = {},
  ): CollectorConfig {
    return {
      tenantId: "t1",
      ingestionBaseUrl: "https://intraday.example.com",
      ingestionSecret: "secret",
      aesHost: "127.0.0.1",
      aesPort,
      monitoredDeviceIds: ["4711"],
      securityToken: "my-security-token",
      ...overrides,
    };
  }

  it("bootstraps RequestSystemStatus with the security token hex-encoded, then MonitorStart per configured device", async () => {
    const collector = new AvayaAuraCollector(makeConfig(), silentLogger, {
      forward: jest.fn(),
    } as never);

    await collector.start();
    try {
      await waitUntil(() => receivedSecurityHex);
      expect(
        Buffer.from(receivedSecurityHex ?? "", "hex").toString("utf8"),
      ).toBe("my-security-token");
      await waitUntil(() =>
        receivedMonitorDeviceIds.length > 0
          ? receivedMonitorDeviceIds
          : undefined,
      );
      expect(receivedMonitorDeviceIds).toEqual(["4711"]);
    } finally {
      collector.stop();
    }
  });

  it("forwards a real AgentReadyEvent as a mapped ActivityEvent", async () => {
    const forward = jest.fn().mockResolvedValue("accepted");
    const collector = new AvayaAuraCollector(makeConfig(), silentLogger, {
      forward,
    } as never);

    await collector.start();
    try {
      await waitUntil(() => aesSocket);
      aesSocket!.write(
        encodeCstaFrame(
          CSTA_EVENT_INVOKE_ID,
          `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${NS}"><agentDevice><deviceIdentifier>4711</deviceIdentifier></agentDevice><agentID>emp-1</agentID></AgentReadyEvent>`,
        ),
      );

      await waitUntil(() =>
        forward.mock.calls.length > 0 ? forward.mock.calls : undefined,
      );
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: "emp-1",
          currentActivity: "ready",
        }),
      );
    } finally {
      collector.stop();
    }
  });

  it("monitors every configured device, one MonitorStart per device", async () => {
    const collector = new AvayaAuraCollector(
      makeConfig({ monitoredDeviceIds: ["4711", "4712", "4713"] }),
      silentLogger,
      { forward: jest.fn() } as never,
    );

    await collector.start();
    try {
      await waitUntil(() =>
        receivedMonitorDeviceIds.length >= 3
          ? receivedMonitorDeviceIds
          : undefined,
      );
      expect(receivedMonitorDeviceIds).toEqual(["4711", "4712", "4713"]);
    } finally {
      collector.stop();
    }
  });

  it("rejects start() when AES refuses the TCP connection", async () => {
    const collector = new AvayaAuraCollector(
      makeConfig({ aesPort: 1 }),
      silentLogger,
      { forward: jest.fn() } as never,
    );

    await expect(collector.start()).rejects.toThrow();
  });
});
