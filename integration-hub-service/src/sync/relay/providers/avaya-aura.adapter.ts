import { Injectable, Logger } from '@nestjs/common';
import { Socket, connect as connectTcp } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { VaultClientService } from '../../../vault/vault-client.service';
import { FieldMappingsService } from '../../../connectors/field-mappings.service';
import { FieldMapping } from '../../../integrations/entities/field-mapping.entity';
import { applyFieldMappings } from '../../batch/providers/field-mapping-transform';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { StreamingRelayAdapter, StreamingRelayCallbacks, StreamingRelaySession } from '../streaming-relay-adapter';
import { BackpressureQueue } from './backpressure-queue';
import { ActivityEvent, IntradayActivityEventClient } from './intraday-activity-event-client';
import { IntradayUpstreamDegradedError } from '../../errors/intraday-forwarding.errors';
import { AvayaAuraApiError } from './avaya-aura-api-client.errors';
import {
  CSTA_EVENT_INVOKE_ID,
  CstaFrame,
  CstaFrameReader,
  CstaInvokeIdGenerator,
  encodeCstaFrame,
} from './csta-xml-frame';

interface AvayaAuraConnectorConfig {
  aesHost?: string;
  aesPort?: number;
  /** Tenant-supplied CSTA deviceIDs (agent extensions) to `MonitorStart` - same "already-aligned IDs, no discovery call" posture ADR-0138/ADR-0141 established for every other streaming adapter's tenant-supplied ID list. */
  monitoredDeviceIds?: string[];
  credentialReference?: string;
  backpressureQueueCapacity?: number;
}

interface AvayaAuraCredential {
  /**
   * Placed in CSTA's own `security` extension field (`CSTACommonArguments.security`,
   * ECMA-323 §9.8) on this adapter's `RequestSystemStatus` association
   * request, hex-encoded per the standard's own established convention for
   * every other credential-shaped field it defines (`AccountInfo`,
   * `AuthCode`, `AgentPassword` are all `xsd:hexBinary`). AES's own actual
   * expectation for this field's content is Avaya-specific and not covered
   * by the public standard - the #1 thing to verify/adjust against a real
   * AES instance.
   */
  securityToken?: string;
}

const AGENT_EVENT_ACTIVITY: Record<string, string> = {
  AgentReadyEvent: 'ready',
  AgentNotReadyEvent: 'notReady',
  AgentBusyEvent: 'busy',
  AgentWorkingAfterCallEvent: 'workingAfterCall',
  AgentLoggedOnEvent: 'loggedOn',
  AgentLoggedOffEvent: 'loggedOff',
};

interface AgentEventBody {
  monitorCrossRefID?: string;
  agentDevice?: { deviceIdentifier?: string };
  agentID?: string;
  acdGroup?: string;
  cause?: string;
}

function hasRequiredActivityFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.employeeId === 'string' &&
    record.employeeId.length > 0 &&
    typeof record.currentActivity === 'string' &&
    record.currentActivity.length > 0 &&
    typeof record.activityStartedAt === 'string' &&
    record.activityStartedAt.length > 0
  );
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * ADR-0168's real `StreamingRelayAdapter` for Avaya Aura Contact
 * Center/CMS - the provider ADR-0142 deferred because this environment has
 * no licensed Avaya Aura Application Enablement Services (AES) instance,
 * no DevConnect-gated TSAPI Client SDK, and (per that ADR) building a
 * client with neither would be unverifiable fabrication. That constraint
 * on *this* environment hasn't changed. What has: a live customer already
 * runs their own AES, and per the connector-config pattern every other
 * adapter here already uses (tenant supplies real endpoint/credentials,
 * e.g. `GenesysCloudAdapter`'s `genesysApiBaseUrl`), the actual
 * verification environment for this adapter is the customer's own AES, not
 * one this codebase provisions.
 *
 * That still leaves the *protocol* gap ADR-0142 raised: Avaya's own
 * TSAPI Client SDK/Programmer's Guide (the thing every real integrator,
 * including the open-source `pytapi`/`TSAPIClient` wrappers found during
 * research, actually builds against) is DevConnect-gated and unavailable
 * here. This adapter does not wrap that SDK. Instead it speaks CSTA-XML
 * directly over a raw TCP socket per **ECMA-323** ("XML Protocol for CSTA
 * Phase III") - a real, freely-published international standard, not
 * Avaya's proprietary encoding - using:
 * - Annex J's real TCP framing (`csta-xml-frame.ts`): 2-byte header, 2-byte
 *   big-endian length, 4-byte ASCII Invoke ID, ASCII XML body.
 * - `RequestSystemStatus` (§A.5.3.5) as the CSTA-association bootstrap -
 *   ECMA-269 §7.2's "implicit association" option, which Annex C names
 *   explicitly for SIP-uaCSTA; applying the same option to a bare TCP
 *   socket is this adapter's own inference by analogy, not something
 *   Annex J states outright for the non-SOAP TCP case.
 * - `MonitorStart`/`MonitorStartResponse` (§13.1.2) against each
 *   tenant-supplied `deviceObject`, schema-verified.
 * - The six real, schema-verified agent-state events (§20.2):
 *   `AgentReadyEvent`, `AgentNotReadyEvent`, `AgentBusyEvent`,
 *   `AgentWorkingAfterCallEvent`, `AgentLoggedOnEvent`,
 *   `AgentLoggedOffEvent` - CSTA models each transition as its own event
 *   type, not one event with a `state` enum.
 *
 * Two real, disclosed gaps this can't close without a real AES to verify
 * against: (1) AES's actual application-level login/authorization
 * preceding CSTA services is Avaya-specific and not defined by ECMA-323 -
 * `AvayaAuraCredential.securityToken` is this adapter's best-effort
 * placement of tenant credential material into CSTA's own `security`
 * extension field, not a confirmed AES contract. (2) None of the six agent
 * event schemas carry a vendor-supplied unique event ID or timestamp
 * (unlike `GenesysCloudAdapter`'s `modifiedDate` or `AxpAdapter`'s
 * `body.id`) - `activityStartedAt` is this adapter's own receipt-time
 * stamp, and `sourceEventId` is synthesized from a per-connection counter,
 * so unlike the other three streaming adapters, a genuine CSTA event
 * retransmit would NOT be deduped by Module 05. Both are called out again
 * at the exact lines below where they're built.
 */
@Injectable()
export class AvayaAuraAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(AvayaAuraAdapter.name);
  readonly provider = 'Avaya Aura Contact Center / CMS';
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    // Without this, fast-xml-parser surfaces the `<?xml ... ?>` prolog as
    // its own leading `"?xml"` key, which would win `Object.keys(parsed)[0]`
    // below over the real root element (e.g. `AgentReadyEvent`).
    ignoreDeclaration: true,
  });

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as AvayaAuraConnectorConfig;
    const host = config.aesHost;
    const port = config.aesPort;
    const deviceIds = config.monitoredDeviceIds;
    if (!host || !port || !deviceIds || deviceIds.length === 0) {
      throw new AvayaAuraApiError(
        'connector.config.aesHost, connector.config.aesPort, and connector.config.monitoredDeviceIds are required',
      );
    }
    if (!config.credentialReference) {
      throw new AvayaAuraApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as AvayaAuraCredential;
    const securityToken = credential.securityToken;

    const mappings = await this.fieldMappings.findAllForConnector(connector.tenantId, connector.id);

    const queue = new BackpressureQueue<ActivityEvent>({
      capacity: config.backpressureQueueCapacity ?? 1000,
      process: async (event) => {
        try {
          const result = await this.intradayClient.forward(connector.tenantId, event);
          if (result.status === 'accepted') {
            callbacks.onEventForwarded();
          }
        } catch (err) {
          if (err instanceof IntradayUpstreamDegradedError) {
            throw err;
          }
          this.logger.warn(`Forwarding event ${event.sourceEventId} to Module 05 failed: ${(err as Error).message}`);
          callbacks.onEventFailed();
        }
      },
      onDropped: (event, reason) => {
        this.logger.warn(`Dropped event ${event.sourceEventId} (${reason})`);
        callbacks.onEventFailed();
      },
    });

    let stopped = false;
    // A monotonic per-connection counter, not any AES-supplied identity -
    // see the class doc comment's gap (2): these events carry no
    // vendor-supplied unique ID, so a real retransmit is not deduped.
    let eventSequence = 0;

    let currentSocket = await this.openAndBootstrap(host, port, securityToken, deviceIds);

    const scheduleReconnect = (attempt: number): void => {
      if (stopped) return;
      const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      this.logger.warn(`Avaya Aura CSTA link closed for connector ${connector.id}; reconnecting in ${delayMs}ms`);
      setTimeout(() => {
        if (stopped) return;
        this.openAndBootstrap(host, port, securityToken, deviceIds)
          .then((socket) => {
            currentSocket = socket;
            attachHandlers(socket, 0);
          })
          .catch((err: Error) => {
            this.logger.warn(`Avaya Aura reconnect attempt ${attempt} failed: ${err.message}`);
            scheduleReconnect(attempt + 1);
          });
      }, delayMs);
    };

    const attachHandlers = (socket: BootstrappedSocket, closeAttempt: number): void => {
      socket.reader = new CstaFrameReader();
      socket.raw.on('data', (chunk: Buffer) => {
        const frames = socket.reader.push(chunk);
        for (const frame of frames) {
          if (frame.invokeId === CSTA_EVENT_INVOKE_ID) {
            eventSequence += 1;
            this.handleEventFrame(frame, eventSequence, mappings, connector, queue, callbacks);
          }
          // Any other Invoke ID here is a service response arriving after
          // this adapter's own bootstrap already resolved it (e.g. a
          // late MonitorStartResponse) - nothing further to do with it.
        }
      });
      socket.raw.on('close', () => scheduleReconnect(closeAttempt));
      socket.raw.on('error', (err: Error) => {
        this.logger.warn(`Avaya Aura CSTA socket error for connector ${connector.id}: ${err.message}`);
      });
    };
    attachHandlers(currentSocket, 0);

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          stopped = true;
          queue.stop();
          currentSocket.raw.destroy();
        },
      },
    };
  }

  async disconnect(session: StreamingRelaySession): Promise<void> {
    const handle = session.handle as { stop: () => Promise<void> };
    await handle.stop();
  }

  private handleEventFrame(
    frame: CstaFrame,
    sequence: number,
    mappings: FieldMapping[],
    connector: IntegrationConnector,
    queue: BackpressureQueue<ActivityEvent>,
    callbacks: StreamingRelayCallbacks,
  ): void {
    let parsed: Record<string, AgentEventBody>;
    try {
      parsed = this.xmlParser.parse(frame.xml) as Record<string, AgentEventBody>;
    } catch {
      return;
    }
    const rootTag = Object.keys(parsed)[0];
    const activity = rootTag ? AGENT_EVENT_ACTIVITY[rootTag] : undefined;
    if (!activity) {
      // A real CSTA event this monitor filter can deliver but this
      // adapter doesn't map to Module 05's activity concept (e.g. a call-
      // control event, if `requestedMonitorFilter` is ever broadened) -
      // not a parse failure, nothing to count.
      return;
    }
    const body = parsed[rootTag];
    const agentDeviceId = body.agentDevice?.deviceIdentifier;
    if (!agentDeviceId) {
      callbacks.onEventFailed();
      return;
    }
    // agentID is `minOccurs="0"` in the real schema - device ID is the
    // one field every one of these six events actually requires.
    const employeeSourceId = body.agentID ?? agentDeviceId;

    const rawRecord: Record<string, unknown> = {
      agentDeviceId,
      agentId: employeeSourceId,
      acdGroup: body.acdGroup,
      cause: body.cause,
      activity,
      // Gap (2) from the class doc comment: no field in any of the six
      // real event schemas carries a vendor timestamp - this is this
      // adapter's own receipt time, not a device-reported event time.
      receivedAtIso: new Date().toISOString(),
    };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      callbacks.onEventFailed();
      return;
    }

    const event: ActivityEvent = {
      // Gap (2) continued: synthesized from a per-connection counter, not
      // an AES-supplied ID - see the class doc comment.
      sourceEventId: `${connector.id}:${employeeSourceId}:${activity}:${sequence}`,
      employeeId: transformed.employeeId as string,
      currentActivity: transformed.currentActivity as string,
      activityStartedAt: transformed.activityStartedAt as string,
      siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
      queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
    };
    queue.enqueue(event);
  }

  private async openAndBootstrap(
    host: string,
    port: number,
    securityToken: string | undefined,
    deviceIds: string[],
  ): Promise<BootstrappedSocket> {
    const raw = await this.openSocket(host, port);
    const bootstrapReader = new CstaFrameReader();
    const invokeIds = new CstaInvokeIdGenerator();

    try {
      await this.sendRequest(
        raw,
        bootstrapReader,
        invokeIds,
        'RequestSystemStatus',
        this.buildRequestSystemStatusXml(securityToken),
      );
      for (const deviceId of deviceIds) {
        await this.sendRequest(raw, bootstrapReader, invokeIds, 'MonitorStart', this.buildMonitorStartXml(deviceId));
      }
    } catch (err) {
      raw.destroy();
      throw err;
    }

    return { raw, reader: bootstrapReader };
  }

  private openSocket(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connectTcp({ host, port });
      const onConnect = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new AvayaAuraApiError(`TCP connection failed: ${err.message}`));
      };
      const cleanup = (): void => {
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
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
        reject(new AvayaAuraApiError(`${expectedResponseTag} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      const onData = (chunk: Buffer): void => {
        for (const frame of reader.push(chunk)) {
          if (frame.invokeId !== invokeId) continue;
          cleanup();
          if (frame.xml.includes('CSTAErrorCode')) {
            reject(new AvayaAuraApiError(`${expectedResponseTag} returned a CSTA fault: ${frame.xml}`));
            return;
          }
          resolve();
          return;
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new AvayaAuraApiError(`socket error while awaiting ${expectedResponseTag}: ${err.message}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(encodeCstaFrame(invokeId, xmlBody));
    });
  }

  /** ECMA-269 §7.2's "implicit association created using CSTA Request System Status" - Annex C names this option explicitly for SIP-uaCSTA; applying it here to a bare TCP socket is this adapter's own inference, not something Annex J states for the non-SOAP TCP case (see the class doc comment). */
  private buildRequestSystemStatusXml(securityToken: string | undefined): string {
    const ns = 'http://www.ecma-international.org/standards/ecma-323/csta/ed6';
    const security = securityToken
      ? `<extensions><security>${Buffer.from(securityToken, 'utf8').toString('hex')}</security></extensions>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?><RequestSystemStatus xmlns="${ns}">${security}</RequestSystemStatus>`;
  }

  /** §13.1.2 `MonitorStart`, schema-verified: `monitorObject` is a `MonitorObject` (`CSTAObject` choice) - `deviceObject` selects the device-monitoring branch over the call-monitoring one. */
  private buildMonitorStartXml(deviceId: string): string {
    const ns = 'http://www.ecma-international.org/standards/ecma-323/csta/ed6';
    return `<?xml version="1.0" encoding="UTF-8"?><MonitorStart xmlns="${ns}"><monitorObject><deviceObject>${deviceId}</deviceObject></monitorObject></MonitorStart>`;
  }
}

interface BootstrappedSocket {
  raw: Socket;
  reader: CstaFrameReader;
}
