import { ConnectionOptions, Msg, NatsConnection, Subscription } from "nats";
import {
  ActivityEvent,
  ActivityEventForwarder,
} from "../src/activity-event-forwarder";
import { CollectorLogger } from "../src/avaya-aura-collector";
import { NatsBusCollector } from "../src/nats-bus-collector";
import { NatsBusCollectorConfig } from "../src/nats-bus-config";

const silentLogger: CollectorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fakeMsg(subject: string, obj: unknown): Msg {
  return {
    subject,
    data: new TextEncoder().encode(JSON.stringify(obj)),
    sid: 1,
  } as Msg;
}

/**
 * Fakes the `nats` client at the `connect()` boundary, the same posture
 * `activity-event-forwarder.spec.ts` takes with an injected `fetch` -
 * this is a wiring test (does this class subscribe to the right subject,
 * map and forward what arrives, shut down cleanly), not a test of the
 * `nats` library itself or of any specific customer's real bus.
 */
function fakeConnection(messages: Msg[]): {
  connectImpl: (opts: ConnectionOptions) => Promise<NatsConnection>;
  calls: {
    opts?: ConnectionOptions;
    subject?: string;
    closed: boolean;
    unsubscribed: boolean;
  };
} {
  const calls: {
    opts?: ConnectionOptions;
    subject?: string;
    closed: boolean;
    unsubscribed: boolean;
  } = {
    closed: false,
    unsubscribed: false,
  };
  const sub = {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: async () =>
          i < messages.length
            ? { value: messages[i++], done: false }
            : { value: undefined, done: true },
      };
    },
    unsubscribe: () => {
      calls.unsubscribed = true;
    },
  } as unknown as Subscription;

  const conn = {
    subscribe: (subject: string) => {
      calls.subject = subject;
      return sub;
    },
    status: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true }),
      }),
    }),
    close: async () => {
      calls.closed = true;
    },
  } as unknown as NatsConnection;

  const connectImpl = async (
    opts: ConnectionOptions,
  ): Promise<NatsConnection> => {
    calls.opts = opts;
    return conn;
  };
  return { connectImpl, calls };
}

const CONFIG: NatsBusCollectorConfig = {
  tenantId: "t1",
  ingestionBaseUrl: "https://intraday.example.com",
  ingestionSecret: "secret",
  natsServers: ["nats://192.168.9.81:4222"],
  natsUser: "app",
  natsPass: "Admin@123",
  natsTlsRejectUnauthorized: true,
  source: { mode: "core", subject: "agent.state.>" },
  fieldMap: { employeeIdField: "agentId", activityField: "state" },
};

describe("NatsBusCollector", () => {
  it("connects with the configured servers/user/pass and subscribes to the configured subject", async () => {
    const { connectImpl, calls } = fakeConnection([]);
    const forwarder = {
      forward: jest.fn(),
    } as unknown as ActivityEventForwarder;
    const collector = new NatsBusCollector(
      CONFIG,
      silentLogger,
      forwarder,
      connectImpl,
    );

    await collector.start();

    expect(calls.opts).toMatchObject({
      servers: ["nats://192.168.9.81:4222"],
      user: "app",
      pass: "Admin@123",
      maxReconnectAttempts: -1,
    });
    expect(calls.subject).toBe("agent.state.>");
    collector.stop();
  });

  it("maps and forwards a message that matches the field map", async () => {
    const messages = [
      fakeMsg("agent.state.emp-1", { agentId: "emp-1", state: "AVAILABLE" }),
    ];
    const { connectImpl } = fakeConnection(messages);
    const forwarded: ActivityEvent[] = [];
    const forwarder = {
      forward: jest.fn(async (event: ActivityEvent) => {
        forwarded.push(event);
        return "accepted";
      }),
    } as unknown as ActivityEventForwarder;
    const collector = new NatsBusCollector(
      CONFIG,
      silentLogger,
      forwarder,
      connectImpl,
    );

    await collector.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      employeeId: "emp-1",
      currentActivity: "AVAILABLE",
    });
    collector.stop();
  });

  it("does not forward a message that fails to map (missing required field)", async () => {
    const messages = [fakeMsg("agent.state.emp-1", { state: "AVAILABLE" })]; // no agentId
    const { connectImpl } = fakeConnection(messages);
    const forwarder = {
      forward: jest.fn(),
    } as unknown as ActivityEventForwarder;
    const collector = new NatsBusCollector(
      CONFIG,
      silentLogger,
      forwarder,
      connectImpl,
    );

    await collector.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(forwarder.forward).not.toHaveBeenCalled();
    collector.stop();
  });

  it("unsubscribes and closes the connection on stop()", async () => {
    const { connectImpl, calls } = fakeConnection([]);
    const forwarder = {
      forward: jest.fn(),
    } as unknown as ActivityEventForwarder;
    const collector = new NatsBusCollector(
      CONFIG,
      silentLogger,
      forwarder,
      connectImpl,
    );

    await collector.start();
    collector.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls.unsubscribed).toBe(true);
    expect(calls.closed).toBe(true);
  });

  it("passes tls: { rejectUnauthorized: false } only when natsTlsRejectUnauthorized is false", async () => {
    const { connectImpl: connectImplRelaxed, calls: callsRelaxed } =
      fakeConnection([]);
    const relaxedCollector = new NatsBusCollector(
      { ...CONFIG, natsTlsRejectUnauthorized: false },
      silentLogger,
      { forward: jest.fn() } as unknown as ActivityEventForwarder,
      connectImplRelaxed,
    );
    await relaxedCollector.start();
    expect(callsRelaxed.opts?.tls).toEqual({ rejectUnauthorized: false });
    relaxedCollector.stop();

    const { connectImpl: connectImplVerified, calls: callsVerified } =
      fakeConnection([]);
    const verifiedCollector = new NatsBusCollector(
      { ...CONFIG, natsTlsRejectUnauthorized: true },
      silentLogger,
      { forward: jest.fn() } as unknown as ActivityEventForwarder,
      connectImplVerified,
    );
    await verifiedCollector.start();
    expect(callsVerified.opts?.tls).toBeUndefined();
    verifiedCollector.stop();
  });
});

describe("NatsBusCollector jetstream mode", () => {
  function fakeJetstreamConnection(messages: unknown[]): {
    connectImpl: (opts: ConnectionOptions) => Promise<NatsConnection>;
    calls: {
      opts?: ConnectionOptions;
      stream?: string;
      consumerOpts?: Record<string, unknown>;
      closed: boolean;
      consumerMessagesClosed: boolean;
    };
  } {
    const calls: {
      opts?: ConnectionOptions;
      stream?: string;
      consumerOpts?: Record<string, unknown>;
      closed: boolean;
      consumerMessagesClosed: boolean;
    } = { closed: false, consumerMessagesClosed: false };

    const consumerMessages = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () =>
            i < messages.length
              ? { value: messages[i++], done: false }
              : { value: undefined, done: true },
        };
      },
      close: async () => {
        calls.consumerMessagesClosed = true;
      },
    };

    const consumer = {
      consume: async () => consumerMessages,
    };

    const js = {
      consumers: {
        get: async (stream: string, opts: Record<string, unknown> | string) => {
          calls.stream = stream;
          calls.consumerOpts =
            typeof opts === "string" ? { boundToName: opts } : opts;
          return consumer;
        },
      },
    };

    const conn = {
      jetstream: () => js,
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
      }),
      close: async () => {
        calls.closed = true;
      },
    } as unknown as NatsConnection;

    const connectImpl = async (
      opts: ConnectionOptions,
    ): Promise<NatsConnection> => {
      calls.opts = opts;
      return conn;
    };
    return { connectImpl, calls };
  }

  const JS_CONFIG: NatsBusCollectorConfig = {
    ...CONFIG,
    source: {
      mode: "jetstream",
      stream: "CC_ACD_ESL_STREAM",
      consumerName: undefined,
      filterSubject: "cc.acd.esl.voice.>",
      deliverPolicy: "new",
    },
  };

  it("gets an unnamed (ordered) consumer for the configured stream, never a named durable one", async () => {
    const { connectImpl, calls } = fakeJetstreamConnection([]);
    const collector = new NatsBusCollector(
      JS_CONFIG,
      silentLogger,
      { forward: jest.fn() } as unknown as ActivityEventForwarder,
      connectImpl,
    );

    await collector.start();

    expect(calls.stream).toBe("CC_ACD_ESL_STREAM");
    expect(calls.consumerOpts).toMatchObject({
      filterSubjects: ["cc.acd.esl.voice.>"],
      deliver_policy: "new",
    });
    // No `name`/`durable_name` key at all - js.consumers.get(stream, opts)
    // with no name creates a private ordered consumer.
    expect(calls.consumerOpts).not.toHaveProperty("name");
    expect(calls.consumerOpts).not.toHaveProperty("durable_name");
    collector.stop();
  });

  it("binds to an existing durable consumer by name when consumerName is set, instead of creating an ordered one", async () => {
    const { connectImpl, calls } = fakeJetstreamConnection([]);
    const collector = new NatsBusCollector(
      {
        ...JS_CONFIG,
        source: {
          ...JS_CONFIG.source,
          consumerName: "AGNO_WFM_COLLECTOR",
        } as NatsBusCollectorConfig["source"],
      },
      silentLogger,
      { forward: jest.fn() } as unknown as ActivityEventForwarder,
      connectImpl,
    );

    await collector.start();

    expect(calls.stream).toBe("CC_ACD_ESL_STREAM");
    expect(calls.consumerOpts).toEqual({ boundToName: "AGNO_WFM_COLLECTOR" });
    collector.stop();
  });

  it("maps and forwards a message pulled through the jetstream consumer", async () => {
    const messages = [
      {
        subject: "cc.acd.esl.voice.emp-1",
        data: new TextEncoder().encode(
          JSON.stringify({ agentId: "emp-1", state: "AVAILABLE" }),
        ),
      },
    ];
    const { connectImpl } = fakeJetstreamConnection(messages);
    const forwarded: ActivityEvent[] = [];
    const collector = new NatsBusCollector(
      JS_CONFIG,
      silentLogger,
      {
        forward: jest.fn(async (event: ActivityEvent) => {
          forwarded.push(event);
          return "accepted";
        }),
      } as unknown as ActivityEventForwarder,
      connectImpl,
    );

    await collector.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      employeeId: "emp-1",
      currentActivity: "AVAILABLE",
    });
    collector.stop();
  });

  it("closes the consumer messages iterator on stop()", async () => {
    const { connectImpl, calls } = fakeJetstreamConnection([]);
    const collector = new NatsBusCollector(
      JS_CONFIG,
      silentLogger,
      { forward: jest.fn() } as unknown as ActivityEventForwarder,
      connectImpl,
    );

    await collector.start();
    collector.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls.consumerMessagesClosed).toBe(true);
    expect(calls.closed).toBe(true);
  });
});
