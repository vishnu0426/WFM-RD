/**
 * Serializes every offline-queue mutation (enqueue/list/remove) behind a
 * single in-memory chain. Without this, a concurrent enqueue-while-syncing
 * lost-update race is real, not hypothetical: `syncEngine` reads an index
 * page, POSTs, then writes the page back with synced ids removed; if the
 * employee taps Clock Out while that sync is in flight, the new enqueue's
 * own read-modify-write on the same index page can be clobbered by
 * whichever finishes last (docs/module-11-phase-3-design-doc.md).
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
