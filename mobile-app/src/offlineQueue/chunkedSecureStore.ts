import * as SecureStore from 'expo-secure-store';
import { Mutex } from './mutex';

/**
 * expo-secure-store has a confirmed ~2048-byte per-value limit on both
 * platforms — one key per item (small) plus a paginated index keeps every
 * individual value well under that, and bounds a single page's own size
 * regardless of how large the overall queue grows during an extended
 * offline period (docs/module-11-phase-3-design-doc.md).
 */
const MAX_IDS_PER_PAGE = 40;

interface Meta {
  pageIds: string[];
  nextPageSeq: number;
}

/**
 * Generic chunked SecureStore-backed collection, shared by the offline
 * action queue and the unresolved-conflicts store — both are "a small
 * list of small JSON records the employee needs to see later," just with
 * different item shapes. All mutating operations run through one mutex
 * per instance, so `add`/`list`/`remove` on the SAME collection can never
 * interleave (docs/module-11-phase-3-design-doc.md's concurrent-enqueue-
 * while-syncing race).
 *
 * Write order on `add`: the item's own payload key is written FIRST, the
 * index append LAST — an app kill between the two leaves an orphaned
 * payload key (harmless, never enumerated again, since expo-secure-store
 * has no key-listing API to find it) rather than a dangling index entry
 * pointing at nothing. `list()` reconciles the opposite case (an index
 * entry whose payload is missing) by dropping it.
 */
export class ChunkedSecureStore<T extends { id: string }> {
  private readonly mutex = new Mutex();

  constructor(private readonly keyPrefix: string) {}

  async add(item: T): Promise<void> {
    return this.mutex.run(async () => {
      await SecureStore.setItemAsync(this.itemKey(item.id), JSON.stringify(item));

      const meta = await this.readMeta();
      let pageId = meta.pageIds[meta.pageIds.length - 1];
      let ids = pageId ? await this.readPage(pageId) : [];
      if (!pageId || ids.length >= MAX_IDS_PER_PAGE) {
        pageId = String(meta.nextPageSeq);
        meta.nextPageSeq += 1;
        meta.pageIds.push(pageId);
        ids = [];
      }
      ids.push(item.id);
      await this.writePage(pageId, ids);
      await this.writeMeta(meta);
    });
  }

  async list(): Promise<T[]> {
    return this.mutex.run(async () => {
      const meta = await this.readMeta();
      const items: T[] = [];
      const nextPageIds: string[] = [];
      let metaDirty = false;

      for (const pageId of meta.pageIds) {
        const ids = await this.readPage(pageId);
        const survivingIds: string[] = [];
        for (const id of ids) {
          const raw = await SecureStore.getItemAsync(this.itemKey(id));
          if (raw) {
            items.push(JSON.parse(raw) as T);
            survivingIds.push(id);
          }
        }

        if (survivingIds.length === ids.length) {
          nextPageIds.push(pageId);
          continue;
        }
        metaDirty = true;
        if (survivingIds.length > 0) {
          await this.writePage(pageId, survivingIds);
          nextPageIds.push(pageId);
        } else {
          await this.deletePage(pageId);
        }
      }

      if (metaDirty) {
        await this.writeMeta({ ...meta, pageIds: nextPageIds });
      }
      return items;
    });
  }

  async remove(id: string): Promise<void> {
    return this.mutex.run(async () => {
      const meta = await this.readMeta();
      const remainingPageIds: string[] = [];
      let metaDirty = false;

      for (const pageId of meta.pageIds) {
        const ids = await this.readPage(pageId);
        if (!ids.includes(id)) {
          remainingPageIds.push(pageId);
          continue;
        }
        metaDirty = true;
        const next = ids.filter((existing) => existing !== id);
        if (next.length === 0) {
          await this.deletePage(pageId);
        } else {
          await this.writePage(pageId, next);
          remainingPageIds.push(pageId);
        }
      }

      if (metaDirty) {
        await this.writeMeta({ ...meta, pageIds: remainingPageIds });
      }
      await SecureStore.deleteItemAsync(this.itemKey(id));
    });
  }

  private metaKey(): string {
    return `${this.keyPrefix}_meta`;
  }
  private pageKey(pageId: string): string {
    return `${this.keyPrefix}_page_${pageId}`;
  }
  private itemKey(id: string): string {
    return `${this.keyPrefix}_item_${id}`;
  }

  private async readMeta(): Promise<Meta> {
    const raw = await SecureStore.getItemAsync(this.metaKey());
    return raw ? (JSON.parse(raw) as Meta) : { pageIds: [], nextPageSeq: 0 };
  }
  private async writeMeta(meta: Meta): Promise<void> {
    await SecureStore.setItemAsync(this.metaKey(), JSON.stringify(meta));
  }
  private async readPage(pageId: string): Promise<string[]> {
    const raw = await SecureStore.getItemAsync(this.pageKey(pageId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  }
  private async writePage(pageId: string, ids: string[]): Promise<void> {
    await SecureStore.setItemAsync(this.pageKey(pageId), JSON.stringify(ids));
  }
  private async deletePage(pageId: string): Promise<void> {
    await SecureStore.deleteItemAsync(this.pageKey(pageId));
  }
}
