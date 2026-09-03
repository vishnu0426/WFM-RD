import { Socket, connect as connectTcp } from "node:net";
import {
  ActivityEvent,
  ActivityEventForwardError,
  ActivityEventForwarder,
} from "./activity-event-forwarder";
import { BackpressureQueue, UpstreamDegradedError } from "./backpressure-queue";
import { CollectorConfig } from "./config";
import { mapCstaEventXmlToActivityEvent } from "./csta-event-mapper";
import {
  CSTA_EVENT_INVOKE_ID,
  CstaFrameReader,
  CstaInvokeIdGenerator,
  encodeCstaFrame,
} from "./csta-xml-frame";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;
const FORWARD_QUEUE_CAPACITY = 1000;
const CSTA_NAMESPACE =
  "http://www.ecma-international.org/standards/ecma-323/csta/ed6";

export interface CollectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: CollectorLogger = {
  info: (m) => console.log(`[collector] ${m}`),
  warn: (m) => console.warn(`[collector] ${m}`),
  error: (m) => console.error(`[collector] ${m}`),
};

interface BootstrappedSocket {
  raw: Socket;
  reader: CstaFrameReader;
}

/**
 * Standalone on-prem counterpart to `integration-hub-service`'s
 * `AvayaAuraAdapter` - same CSTA-XML-over-TCP protocol (ECMA-323 Annex J
 * framing, `RequestSystemStatus`/`MonitorStart` bootstrap, the six real
 * agent-state events), ported to run *inside the customer's network*
 * instead of being dialed into from our cloud. See the package README for
 * why: a shared multi-tenant cloud service can't reach an AES server
 * sitting behind a customer's firewall, but this process - deployed on
 * their own network - reaches AES locally and only ever needs outbound
 * HTTPS to push events out, which corporate firewalls almost always allow
 * (unlike accepting an inbound connection, which most refuse).
 *
 * Two gaps this can't close without a real AES to verify against, same as
 * the cloud-side adapter (see that class's own doc comment for the fuller
 * discussion): (1) AES's actual application-level login/authorization is
 * Avaya-specific and not defined by the public ECMA-323 standard -
 * `securityToken` is this collector's best-effort placement of that
 * credential into CSTA's own `security` extension field, not a confirmed
 * AES contract; (2) none of the six agent event schemas carry a vendor
 * event ID or timestamp, so `activityStartedAt` is this collector's own
 * receipt time and a genuine CSTA retransmit would not be deduped
 * downstream.
 */
export class AvayaAuraCollector {
  private readonly logger: CollectorLogger;
  private readonly forwarder: ActivityEventForwarder;
  private readonly queue: BackpressureQueue<ActivityEvent>;
  private stopped = false;
  private eventSequence = 0;
  private currentSocket: BootstrappedSocket | undefined;

  constructor(
    private readonly config: CollectorConfig,
    logger: CollectorLogger = consoleLogger,
    forwarder?: ActivityEventForwarder,
  ) {
    this.logger = logger;
    this.forwarder =
      forwarder ??
      new ActivityEventForwarder(
        config.ingestionBaseUrl,
        config.tenantId,
        config.ingestionSecret,
      );
    this.queue = new BackpressureQueue({
      capacity: FORWARD_QUEUE_CAPACITY,
      process: async (event) => {
        try {
          await this.forwarder.forward(event);
        } catch (err) {
          if (
            err instanceof ActivityEventForwardError &&
            (err.status === undefined || err.status >= 500)
          ) {
            throw new UpstreamDegradedError(err.message);
          }
          this.logger.warn(
            `Forwarding event ${event.sourceEventId} failed permanently: ${(err as Error).message}`,
          );
        }
      },
      onDropped: (event, reason) => {
        this.logger.warn(`Dropped event ${event.sourceEventId} (${reason})`);
      },
      onDegraded: (attempt, delayMs) => {
        this.logger.warn(
          `Ingestion endpoint degraded, retrying in ${delayMs}ms (attempt ${attempt + 1})`,
        );
      },
    });
  }

  async start(): Promise<void> {
    this.currentSocket = await this.openAndBootstrap();
    this.attachHandlers(this.currentSocket, 0);
    this.logger.info(
      `Connected to AES ${this.config.aesHost}:${this.config.aesPort}, monitoring ${this.config.monitoredDeviceIds.length} device(s)`,
    );
  }

  stop(): void {
    this.stopped = true;
    this.queue.stop();
    this.currentSocket?.raw.destroy();
  }

  private attachHandlers(
    socket: BootstrappedSocket,
    closeAttempt: number,
  ): void {
    socket.raw.on("data", (chunk: Buffer) => {
      const frames = socket.reader.push(chunk);
      for (const frame of frames) {
        if (frame.invokeId === CSTA_EVENT_INVOKE_ID) {
          this.eventSequence += 1;
          const event = mapCstaEventXmlToActivityEvent(
            frame.xml,
            this.eventSequence,
            this.config.tenantId,
          );
          if (event) {
            this.queue.enqueue(event);
          }
        }
        // Any other Invoke ID here is a service response arriving after
        // this collector's own bootstrap already resolved it - nothing
        // further to do with it.
      }
    });
    socket.raw.on("close", () => this.scheduleReconnect(closeAttempt));
    socket.raw.on("error", (err: Error) =>
      this.logger.warn(`AES socket error: ${err.message}`),
    );
  }

  private scheduleReconnect(attempt: number): void {
    if (this.stopped) return;
    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** attempt,
    );
    this.logger.warn(`AES CSTA link closed; reconnecting in ${delayMs}ms`);
    setTimeout(() => {
      if (this.stopped) return;
      this.openAndBootstrap()
        .then((socket) => {
          this.currentSocket = socket;
          this.attachHandlers(socket, 0);
        })
        .catch((err: Error) => {
          this.logger.warn(
            `Reconnect attempt ${attempt} failed: ${err.message}`,
          );
          this.scheduleReconnect(attempt + 1);
        });
    }, delayMs);
  }

  private async openAndBootstrap(): Promise<BootstrappedSocket> {
    const raw = await this.openSocket();
    const bootstrapReader = new CstaFrameReader();
    const invokeIds = new CstaInvokeIdGenerator();

    try {
      await this.sendRequest(
        raw,
        bootstrapReader,
        invokeIds,
        "RequestSystemStatus",
        this.buildRequestSystemStatusXml(),
      );
      for (const deviceId of this.config.monitoredDeviceIds) {
        await this.sendRequest(
          raw,
          bootstrapReader,
          invokeIds,
          "MonitorStart",
          this.buildMonitorStartXml(deviceId),
        );
      }
    } catch (err) {
      raw.destroy();
      throw err;
    }

    return { raw, reader: bootstrapReader };
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connectTcp({
        host: this.config.aesHost,
        port: this.config.aesPort,
      });
      const onConnect = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new Error(`TCP connection to AES failed: ${err.message}`));
      };
      const cleanup = (): void => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  /** Sends one CSTA-XML request and resolves once its correlated response frame (by Invoke ID) arrives, or rejects on a CSTA fault/timeout. Only used during the bootstrap dance - `attachHandlers`'s own reader takes over for the connection's real lifetime once this resolves. */
  private sendRequest(
    socket: Socket,
    reader: CstaFrameReader,
    invokeIds: CstaInvokeIdGenerator,
    expectedResponseTag: string,
    xmlBody: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const invokeId = invokeIds.generate();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `${expectedResponseTag} timed out after ${REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);

      const onData = (chunk: Buffer): void => {
        for (const frame of reader.push(chunk)) {
          if (frame.invokeId !== invokeId) continue;
          cleanup();
          if (frame.xml.includes("CSTAErrorCode")) {
            reject(
              new Error(
                `${expectedResponseTag} returned a CSTA fault: ${frame.xml}`,
              ),
            );
            return;
          }
          resolve();
          return;
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(
          new Error(
            `socket error while awaiting ${expectedResponseTag}: ${err.message}`,
          ),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
      };

      socket.on("data", onData);
      socket.on("error", onError);
      socket.write(encodeCstaFrame(invokeId, xmlBody));
    });
  }

  /** ECMA-269 §7.2's "implicit association created using CSTA Request System Status" - same inference-by-analogy the cloud-side adapter documents (Annex J doesn't state this outright for the non-SOAP TCP case). */
  private buildRequestSystemStatusXml(): string {
    const security = this.config.securityToken
      ? `<extensions><security>${Buffer.from(this.config.securityToken, "utf8").toString("hex")}</security></extensions>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?><RequestSystemStatus xmlns="${CSTA_NAMESPACE}">${security}</RequestSystemStatus>`;
  }

  /** §13.1.2 `MonitorStart`, schema-verified: `deviceObject` selects the device-monitoring branch of the `MonitorObject` choice. */
  private buildMonitorStartXml(deviceId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><MonitorStart xmlns="${CSTA_NAMESPACE}"><monitorObject><deviceObject>${deviceId}</deviceObject></monitorObject></MonitorStart>`;
  }
}
