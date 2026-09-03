import * as secureStoreMock from '@/testing/mocks/secureStore';

import { ChunkedSecureStore } from '../chunkedSecureStore';

interface Item {
  id: string;
  value: string;
}

describe('ChunkedSecureStore', () => {
  it('adds and lists items, preserving insertion order', async () => {
    const store = new ChunkedSecureStore<Item>('test_queue');

    await store.add({ id: 'a', value: '1' });
    await store.add({ id: 'b', value: '2' });
    await store.add({ id: 'c', value: '3' });

    expect(await store.list()).toEqual([
      { id: 'a', value: '1' },
      { id: 'b', value: '2' },
      { id: 'c', value: '3' },
    ]);
  });

  it('removes an item and no longer lists it', async () => {
    const store = new ChunkedSecureStore<Item>('test_queue');
    await store.add({ id: 'a', value: '1' });
    await store.add({ id: 'b', value: '2' });

    await store.remove('a');

    expect(await store.list()).toEqual([{ id: 'b', value: '2' }]);
  });

  it('spans multiple index pages once a page fills up, and lists items across all of them', async () => {
    const store = new ChunkedSecureStore<Item>('test_queue');
    const ids = Array.from({ length: 45 }, (_, i) => `item-${i}`);

    for (const id of ids) {
      await store.add({ id, value: id });
    }

    const listed = await store.list();
    expect(listed.map((item) => item.id)).toEqual(ids);
  });

  it('reconciles a dangling index entry whose payload is missing, without throwing', async () => {
    const store = new ChunkedSecureStore<Item>('test_queue');
    await store.add({ id: 'a', value: '1' });
    await store.add({ id: 'b', value: '2' });

    // Simulate an app-killed-mid-write scenario at the storage layer
    // directly: an index entry survives but its payload key doesn't.
    await secureStoreMock.deleteItemAsync('test_queue_item_a');

    const listed = await store.list();
    expect(listed).toEqual([{ id: 'b', value: '2' }]);

    // The reconciliation should have persisted - a second list() call
    // shouldn't need to reconcile again (nothing left to drop).
    const listedAgain = await store.list();
    expect(listedAgain).toEqual([{ id: 'b', value: '2' }]);
  });

  it('serializes a concurrent add and list so neither observes a torn intermediate state', async () => {
    const store = new ChunkedSecureStore<Item>('test_queue');
    await store.add({ id: 'a', value: '1' });

    const [, listed] = await Promise.all([store.add({ id: 'b', value: '2' }), store.list()]);

    // Whichever operation the mutex ran second still sees a fully
    // consistent state - either just 'a', or both 'a' and 'b', never a
    // partially-written page.
    expect(listed.length === 1 || listed.length === 2).toBe(true);
    expect(listed.every((item) => ['a', 'b'].includes(item.id))).toBe(true);

    const final = await store.list();
    expect(final.map((item) => item.id).sort()).toEqual(['a', 'b']);
  });
});
