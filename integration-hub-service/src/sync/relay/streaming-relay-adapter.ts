import { IntegrationConnector } from '../../integrations/entities/integration-connector.entity';

/** Opaque to the relay service itself - whatever a real adapter (Phase 6/6b) needs to later disconnect (a WebSocket handle, an AES/TSAPI session handle, an SSE stream, etc.). */
export interface StreamingRelaySession {
  readonly connectorId: string;
  readonly handle: unknown;
}

/**
 * §2.1's streaming-row semantics: "records_processed = events forwarded in
 * the window" - a running session reports its own progress continuously
 * over its lifetime via these callbacks, not once at the end (Phase 6,
 * added alongside the first real adapter that has real progress to
 * report).
 */
export interface StreamingRelayCallbacks {
  onEventForwarded(): void;
  onEventFailed(): void;
}

/**
 * §5c/§7 Phase 6/6b's real contract: terminate a cloud provider's webhook/
 * WebSocket (Genesys, Avaya AXP, etc.) or a non-REST on-prem worker (Avaya
 * Aura/CMS), verify+transform each event via `FieldMapping`, forward
 * immediately to Module 05's `activity-events` endpoint (§2.2 rule 3b) -
 * none of that is implemented by this interface itself. Phase 2 built the
 * shape and the service that calls it; Phase 6 is the first real adapter.
 */
export interface StreamingRelayAdapter {
  readonly provider: string;
  connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession>;
  disconnect(session: StreamingRelaySession): Promise<void>;
}

export const STREAMING_RELAY_ADAPTERS = Symbol('STREAMING_RELAY_ADAPTERS');
