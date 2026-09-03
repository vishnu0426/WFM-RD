import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';

/**
 * Bump on any change to a persisted query's response shape so a stale/
 * incompatible cache from a prior app version is discarded on next launch
 * instead of being hydrated as if valid.
 */
export const CACHE_BUSTER = 'mobile-app-cache-v1';

/**
 * Plain AsyncStorage, not encrypted storage — acceptable here since cached
 * shift timestamps aren't sensitive the way auth tokens are. Phase 3
 * introduces encrypted storage for the offline action queue and may absorb
 * this cache too (docs/module-11-phase-1-design-doc.md, Explicit assumptions).
 */
export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'AGNO_WFM_MOBILE_QUERY_CACHE',
});
