import { IntradayUpstreamDegradedError } from '../../errors/intraday-forwarding.errors';

export type DropReason = 'queue_full' | 'sustained_degradation';

export interface BackpressureQueueOptions<T> {
  /** §5a: "a bounded queue... rather than an unbounded forward-as-fast-as-possible loop." */
  capacity: number;
  /** Forwards one item. Must swallow/handle a genuine per-item failure internally (log it, count it) - only a degradation signal should propagate out of this function. */
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
 * §5a's backpressure guard for the relay's outbound leg to Module 05 -
 * "a bounded queue with backoff if Module 05 signals degradation." A real
 * `IntradayUpstreamDegradedError` (Module 05's own 503) pauses the drain
 * loop and retries the *same* item with exponential backoff, up to
 * `maxDegradedRetries`; a queue at capacity drops the newest incoming
 * event rather than growing unbounded - both drop paths are counted via
 * `onDropped`, never silent (matching this platform's "no silent caps -
 * log what was dropped" convention).
 */
export class BackpressureQueue<T> {
  private readonly queue: T[] = [];
  private draining = false;
  private stopped = false;

  constructor(private readonly options: BackpressureQueueOptions<T>) {}

  enqueue(item: T): boolean {
    if (this.stopped) return false;
    if (this.queue.length >= this.options.capacity) {
      this.options.onDropped?.(item, 'queue_full');
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
    const maxDegradedRetries = this.options.maxDegradedRetries ?? DEFAULT_MAX_DEGRADED_RETRIES;
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
          if (!(err instanceof IntradayUpstreamDegradedError)) {
            // A genuine per-item failure should already have been handled
            // (logged/counted) inside `process` - this queue's own job is
            // only to react to *degradation*, not to know about domain
            // failure shapes.
            this.queue.shift();
            break;
          }
          if (degradedAttempt >= maxDegradedRetries) {
            this.queue.shift();
            this.options.onDropped?.(item, 'sustained_degradation');
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
