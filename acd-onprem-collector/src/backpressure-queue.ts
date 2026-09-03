export type DropReason = "queue_full" | "sustained_degradation";

/** Thrown by a `BackpressureQueue`'s `process` callback to signal "the upstream is degraded, retry this same item with backoff" - anything else thrown is treated as a genuine per-item failure (logged/counted by the caller, item dropped, queue moves on). */
export class UpstreamDegradedError extends Error {}

export interface BackpressureQueueOptions<T> {
  /** A bounded queue, not an unbounded forward-as-fast-as-possible loop - matches `integration-hub-service`'s own reasoning for its cloud-side relay adapters. */
  capacity: number;
  /** Forwards one item. Must swallow/handle a genuine per-item failure internally (log it, count it) - only a degradation signal (`UpstreamDegradedError`) should propagate out of this function. */
  process: (item: T) => Promise<void>;
  /** Exponential by default: `Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)`. */
  backoffMs?: (attempt: number) => number;
  /** After this many consecutive degraded retries on the *same* item, give up on it and move on - an unbounded retry would let one stuck item block every event behind it forever. */
  maxDegradedRetries?: number;
  onDropped?: (item: T, reason: DropReason) => void;
  onDegraded?: (attempt: number, delayMs: number) => void;
}

const DEFAULT_MAX_DEGRADED_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30000;

/**
 * Port of `integration-hub-service`'s own `BackpressureQueue` (its
 * `src/sync/relay/providers/backpressure-queue.ts`), decoupled from that
 * service's `IntradayUpstreamDegradedError` in favor of this package's own
 * `UpstreamDegradedError` - same behavior, no cross-service import (this
 * collector has no dependency on `integration-hub-service` at all, by
 * design - see `csta-xml-frame.ts`'s own doc comment for why duplication
 * beats a shared package here).
 */
export class BackpressureQueue<T> {
  private readonly queue: T[] = [];
  private draining = false;
  private stopped = false;

  constructor(private readonly options: BackpressureQueueOptions<T>) {}

  enqueue(item: T): boolean {
    if (this.stopped) return false;
    if (this.queue.length >= this.options.capacity) {
      this.options.onDropped?.(item, "queue_full");
      return false;
    }
    this.queue.push(item);
    this.kick();
    return true;
  }

  get size(): number {
    return this.queue.length;
  }

  stop(): void {
    this.stopped = true;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    const maxDegradedRetries =
      this.options.maxDegradedRetries ?? DEFAULT_MAX_DEGRADED_RETRIES;
    const backoffMs = this.options.backoffMs ?? this.defaultBackoffMs;

    while (!this.stopped && this.queue.length > 0) {
      const item = this.queue[0];
      let degradedAttempt = 0;

      for (;;) {
        try {
          await this.options.process(item);
          this.queue.shift();
          break;
        } catch (err) {
          if (!(err instanceof UpstreamDegradedError)) {
            this.queue.shift();
            break;
          }
          if (degradedAttempt >= maxDegradedRetries) {
            this.queue.shift();
            this.options.onDropped?.(item, "sustained_degradation");
            break;
          }
          const delayMs = backoffMs(degradedAttempt);
          this.options.onDegraded?.(degradedAttempt, delayMs);
          degradedAttempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (this.stopped) return;
        }
      }
    }
    this.draining = false;
  }

  private defaultBackoffMs(attempt: number): number {
    return Math.min(DEFAULT_MAX_DELAY_MS, DEFAULT_BASE_DELAY_MS * 2 ** attempt);
  }
}
