import { OfflineActionQueue } from '../mobile-sync/entities/offline-action-queue.entity';
import { DeviceRegistration } from '../devices/entities/device-registration.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention every other service's own
 * `src/database/entities.ts` uses.
 */
export const entities = [OfflineActionQueue, DeviceRegistration];

export { OfflineActionQueue, DeviceRegistration };
