import {
  connect,
  ConnectionOptions,
  Consumer,
  ConsumerMessages,
  DeliverPolicy,
  NatsConnection,
  Subscription,
} from "nats";
import {
  ActivityEvent,
  ActivityEventForwardError,
  ActivityEventForwarder,
} from "./activity-event-forwarder";
import { CollectorLogger, consoleLogger } from "./avaya-aura-collector";
import { BackpressureQueue, UpstreamDegradedError } from "./backpressure-queue";
import { NatsBusCollectorConfig, NatsBusSource } from "./nats-bus-config";
import { mapNatsPayloadToActivityEvent } from "./nats-bus-event-mapper";

/** Structural shape shared by core-NATS `Msg` and JetStream's `JsMsg` - `handleMessage` only needs this much, so one method serves both delivery modes. */
interface ReceivedMsg {
  data: Uint8Array;
  subject: string;
}

function toDeliverPolicy(
  policy: Extract<NatsBusSource, { mode: "jetstream" }>["deliverPolicy"],
): DeliverPolicy {
  switch (policy) {
    case "all":
      return DeliverPolicy.All;
    case "last":
      return DeliverPolicy.Last;
    case "new":
      return DeliverPolicy.New;
  }
}

const FORWARD_QUEUE_CAPACITY = 1000;

/**
 * Input adapter for a customer whose own ACD/contact-center stack already
 * publishes agent-state events onto their own NATS bus - the README's
 * "Extending this pattern to a different on-prem ACD" section, now built.
 *
 * Everything downstream of "I have a parsed ActivityEvent" is identical to
 * `AvayaAuraCollector`: same `ActivityEventForwarder` (HMAC-signed HTTPS
 * POST to intraday-service's ingestion endpoint), same `BackpressureQueue`
 * retry/backoff posture, same `stop()`/`start()` lifecycle. Only the
 * *source* differs - subscribe to the customer's own bus instead of
 * speaking CSTA to an AES server - which is exactly the swap the README
 * describes as the reusable part of this package.
 *
 * Unlike the raw TCP/CSTA socket this package speaks to AES, there's no
 * protocol-level bootstrap dance to redo on every reconnect here: the
 * `nats` client library already does connection-level reconnect with its
 * own backoff (`maxReconnectAttempts: -1` below - never give up), so this
 * class doesn't reimplement one, it only logs status transitions.
 *
 * Connection + TLS handling and the `jetstream` mode's consumer wiring have
 * been verified against a real customer bus (2026-09): connect, TLS
 * handshake against their self-signed cert, and stream/consumer discovery
 * all confirmed live. Actually forwarding a real event end to end through
 * `jetstream` mode has only been exercised against a local `nats-server`,
 * not yet pulled from that customer's real stream - the payload shape is
 * 100% customer-specific and arrives only via
 * `NatsBusCollectorConfig.fieldMap`/`source`.
 */
export class NatsBusCollector {
  private readonly logger: CollectorLogger;
  private readonly forwarder: ActivityEventForwarder;
  private readonly queue: BackpressureQueue<ActivityEvent>;
  private connection: NatsConnection | undefined;
  private subscription: Subscription | undefined;
  private jsConsumer: Consumer | undefined;
  private jsMessages: ConsumerMessages | undefined;
  private stopped = false;
  private eventSequence = 0;

  constructor(
    private readonly config: NatsBusCollectorConfig,
    logger: CollectorLogger = consoleLogger,
    forwarder?: ActivityEventForwarder,
    private readonly connectImpl: (
      opts: ConnectionOptions,
    ) => Promise<NatsConnection> = connect,
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
    this.connection = await this.connectImpl({
      servers: this.config.natsServers,
      user: this.config.natsUser,
      pass: this.config.natsPass,
      maxReconnectAttempts: -1,
      // `TlsOptions`'s published type omits `rejectUnauthorized`, but the
      // client honors it if present - confirmed against a real customer's
      // self-signed-cert NATS server. Setting Node's process-wide
      // NODE_TLS_REJECT_UNAUTHORIZED does *not* work here: this library
      // builds its TLS socket options as
      // `{ rejectUnauthorized: true, ...this.options.tls }`, so only a
      // connection-scoped `tls.rejectUnauthorized` override actually takes
      // effect.
      tls: this.config.natsTlsRejectUnauthorized
        ? undefined
        : ({ rejectUnauthorized: false } as ConnectionOptions["tls"]),
    });
    this.logger.info(
      `Connected to customer NATS bus (${this.config.natsServers.join(", ")})`,
    );

    void this.watchStatus(this.connection);

    if (this.config.source.mode === "jetstream") {
      await this.startJetstream(this.connection, this.config.source);
    } else {
      this.logger.info(`Subscribing to "${this.config.source.subject}"`);
      this.subscription = this.connection.subscribe(this.config.source.subject);
      void this.consume(this.subscription);
    }
  }

  private async startJetstream(
    connection: NatsConnection,
    source: Extract<NatsBusSource, { mode: "jetstream" }>,
  ): Promise<void> {
    const js = connection.jetstream();

    if (source.consumerName) {
      // Bind to a durable consumer the customer already created and
      // authorized for this credential - required when their NATS
      // permissions only allow pulling from pre-authorized consumer
      // names (confirmed against a real customer bus: creating an
      // ephemeral consumer succeeded, but pulling from it hung forever -
      // the pull request was silently dropped as unauthorized). This
      // must be a name dedicated to this integration, never one another
      // of the customer's own systems already pulls from - see the
      // no-`consumerName` branch below for why sharing a name is unsafe.
      this.logger.info(
        `Binding to existing durable consumer "${source.consumerName}" on stream "${source.stream}"`,
      );
      this.jsConsumer = await js.consumers.get(
        source.stream,
        source.consumerName,
      );
    } else {
      this.logger.info(
        `Attaching an ordered JetStream consumer to stream "${source.stream}"` +
          (source.filterSubject
            ? ` filtered to "${source.filterSubject}"`
            : ""),
      );
      // `js.consumers.get(stream, opts)` with no consumer *name* creates a
      // private, self-healing ordered consumer - it never binds to an
      // existing durable consumer name. That matters here: some customer
      // buses already have another one of their own systems pulling from a
      // named durable consumer on this stream, and JetStream fans a durable
      // pull consumer's messages out across every puller bound to it - so
      // reusing that name would silently steal a share of their events
      // instead of getting our own full copy of the stream. Only usable if
      // the credential is permitted to create consumers on demand.
      this.jsConsumer = await js.consumers.get(source.stream, {
        filterSubjects: source.filterSubject
          ? [source.filterSubject]
          : undefined,
        deliver_policy: toDeliverPolicy(source.deliverPolicy),
      });
    }

    this.jsMessages = await this.jsConsumer.consume();
    void this.consumeJs(this.jsMessages);
  }

  stop(): void {
    this.stopped = true;
    this.queue.stop();
    this.subscription?.unsubscribe();
    void this.jsMessages?.close();
    void this.connection?.close();
  }

  private async consume(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      if (this.stopped) break;
      this.handleMessage(msg);
    }
  }

  private async consumeJs(messages: ConsumerMessages): Promise<void> {
    for await (const msg of messages) {
      if (this.stopped) break;
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: ReceivedMsg): void {
    this.eventSequence += 1;
    const event = mapNatsPayloadToActivityEvent(
      msg.data,
      this.config.fieldMap,
      this.config.tenantId,
      this.eventSequence,
    );
    if (event) {
      this.queue.enqueue(event);
    } else {
      this.logger.warn(
        `Message on "${msg.subject}" did not map to an ActivityEvent - check CUSTOMER_NATS_FIELD_MAP`,
      );
    }
  }

  private async watchStatus(connection: NatsConnection): Promise<void> {
    for await (const status of connection.status()) {
      if (this.stopped) return;
      if (status.type === "disconnect") {
        this.logger.warn(
          `Disconnected from customer NATS bus (data: ${JSON.stringify(status.data ?? null)})`,
        );
      } else if (status.type === "reconnect") {
        this.logger.info("Reconnected to customer NATS bus");
      } else if (status.type === "error") {
        this.logger.warn(
          `Customer NATS bus error (data: ${JSON.stringify(status.data ?? null)})`,
        );
      }
    }
  }
}
