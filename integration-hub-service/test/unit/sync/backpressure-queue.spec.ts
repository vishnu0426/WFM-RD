import { BackpressureQueue } from '../../../src/sync/relay/providers/backpressure-queue';
import { IntradayUpstreamDegradedError } from '../../../src/sync/errors/intraday-forwarding.errors';

function flush(): Promise<void> {
  // A real macrotask tick, not `setImmediate` - the queue's own retry
  // delay is a real `setTimeout`, and interleaving with it reliably needs
  // the same phase of the event loop, not just any "next tick."
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMany(times: number): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

describe('BackpressureQueue', () => {
  it('processes items in order via the process function', async () => {
    const processed: number[] = [];
    const queue = new BackpressureQueue<number>({
      capacity: 10,
      process: async (item) => {
        processed.push(item);
      },
    });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    await flush();
    await flush();
    await flush();
    expect(processed).toEqual([1, 2, 3]);
  });

  it('drops newly-enqueued items with queue_full while an in-flight item holds the queue at capacity', async () => {
    const dropped: Array<[number, string]> = [];
    let releaseFirst: (() => void) | undefined;
    const queue = new BackpressureQueue<number>({
      capacity: 1,
      process: (item) =>
        new Promise((resolve) => {
          if (item === 1) releaseFirst = resolve;
          else resolve();
        }),
      onDropped: (item, reason) => dropped.push([item, reason]),
    });
    // Item 1 is enqueued, synchronously grabbed by the drain loop, and
    // parked mid-`process()` (its promise not yet resolved) - it still
    // occupies the one slot capacity 1 allows.
    queue.enqueue(1);
    expect(queue.enqueue(2)).toBe(false);
    expect(queue.enqueue(3)).toBe(false);
    expect(dropped).toEqual([
      [2, 'queue_full'],
      [3, 'queue_full'],
    ]);
    releaseFirst?.();
    await flush();
  });

  it('retries on IntradayUpstreamDegradedError with backoff, then succeeds', async () => {
    let attempts = 0;
    const degradedEvents: Array<[number, number]> = [];
    const queue = new BackpressureQueue<string>({
      capacity: 10,
      backoffMs: () => 0,
      onDegraded: (attempt, delayMs) => degradedEvents.push([attempt, delayMs]),
      process: async () => {
        attempts++;
        if (attempts < 3) {
          throw new IntradayUpstreamDegradedError('simulated 503');
        }
      },
    });
    queue.enqueue('event-1');
    await flushMany(10);
    expect(attempts).toBe(3);
    expect(degradedEvents).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('gives up after maxDegradedRetries, drops with sustained_degradation, and continues with the next item', async () => {
    const dropped: Array<[string, string]> = [];
    const processed: string[] = [];
    const queue = new BackpressureQueue<string>({
      capacity: 10,
      backoffMs: () => 0,
      maxDegradedRetries: 2,
      onDropped: (item, reason) => dropped.push([item, reason]),
      process: async (item) => {
        if (item === 'always-degraded') {
          throw new IntradayUpstreamDegradedError('simulated sustained 503');
        }
        processed.push(item);
      },
    });
    queue.enqueue('always-degraded');
    queue.enqueue('fine');
    await flushMany(20);
    expect(dropped).toEqual([['always-degraded', 'sustained_degradation']]);
    expect(processed).toEqual(['fine']);
  });

  it('a genuine (non-degradation) error thrown from process moves on to the next item without retrying', async () => {
    const processed: string[] = [];
    const queue = new BackpressureQueue<string>({
      capacity: 10,
      process: async (item) => {
        if (item === 'bad') throw new Error('some genuine per-item failure, already logged by the caller');
        processed.push(item);
      },
    });
    queue.enqueue('bad');
    queue.enqueue('good');
    await flush();
    await flush();
    expect(processed).toEqual(['good']);
  });

  it('stop() halts further draining', async () => {
    const processed: string[] = [];
    const queue = new BackpressureQueue<string>({
      capacity: 10,
      process: async (item) => {
        processed.push(item);
      },
    });
    queue.enqueue('a');
    await flush();
    queue.stop();
    queue.enqueue('b');
    await flush();
    expect(queue.enqueue('c')).toBe(false);
    expect(processed).toEqual(['a']);
  });
});
