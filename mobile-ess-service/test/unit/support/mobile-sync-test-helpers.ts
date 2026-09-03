import { DataSource, EntityManager, Repository } from 'typeorm';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { MobileSyncActionDto } from '../../../src/mobile-sync/dto/mobile-sync-batch-request.dto';
import {
  OfflineActionQueue,
  OfflineActionStatus,
  OfflineActionType,
} from '../../../src/mobile-sync/entities/offline-action-queue.entity';
import { MobileSyncService } from '../../../src/mobile-sync/mobile-sync.service';
import { AttendanceClockEventClient } from '../../../src/mobile-sync/providers/attendance-clock-event-client';
import { LeaveRequestClient } from '../../../src/mobile-sync/providers/leave-request-client';
import { MarketplaceClaimClient } from '../../../src/mobile-sync/providers/marketplace-claim-client';
import { GeofenceVerificationService } from '../../../src/geofence/geofence-verification.service';

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
export const ACTION_ID = '33333333-3333-4333-8333-333333333333';

export function buildAction(overrides: Partial<MobileSyncActionDto> = {}): MobileSyncActionDto {
  return {
    id: ACTION_ID,
    employeeId: EMPLOYEE_ID,
    actionType: OfflineActionType.CLOCK_EVENT,
    payload: { eventType: 'clock_in' },
    createdAtDevice: '2026-08-14T09:00:00.000Z',
    ...overrides,
  };
}

export function buildRow(overrides: Partial<OfflineActionQueue> = {}): OfflineActionQueue {
  const row = new OfflineActionQueue();
  row.id = ACTION_ID;
  row.tenantId = TENANT_ID;
  row.employeeId = EMPLOYEE_ID;
  row.actionType = OfflineActionType.CLOCK_EVENT;
  row.payload = { eventType: 'clock_in' };
  row.status = OfflineActionStatus.PENDING_SYNC;
  row.createdAtDevice = new Date('2026-08-14T09:00:00.000Z');
  row.receivedAt = new Date();
  row.syncedAt = null;
  row.conflictDetails = null;
  row.geofenceVerified = null;
  return Object.assign(row, overrides);
}

export class FakeUniqueViolation extends Error {
  code = '23505';
}

export interface MobileSyncTestContext {
  repo: jest.Mocked<Repository<OfflineActionQueue>>;
  attendanceClient: jest.Mocked<AttendanceClockEventClient>;
  leaveRequestClient: jest.Mocked<LeaveRequestClient>;
  marketplaceClaimClient: jest.Mocked<MarketplaceClaimClient>;
  geofenceVerification: jest.Mocked<GeofenceVerificationService>;
  service: MobileSyncService;
}

/**
 * `MobileSyncService` routes every query through `withTenantConnection`
 * (`dataSource.transaction(...)`, see that helper's own doc comment on why
 * - RLS's `app.current_tenant_id` GUC). Same fake-transaction pattern
 * `attendance-ingestion.service.spec.ts` uses: `DataSource.transaction` is
 * faked to invoke the callback with a mocked `EntityManager` whose
 * `getRepository` returns this mocked `Repository`, so existing assertions
 * against `repo.*` keep working unchanged.
 */
export function createMobileSyncTestContext(): MobileSyncTestContext {
  const repo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    create: jest.fn((entity) => Object.assign(new OfflineActionQueue(), entity)),
    save: jest.fn((entity) => Promise.resolve(entity)),
  } as unknown as jest.Mocked<Repository<OfflineActionQueue>>;

  const manager = { getRepository: jest.fn().mockReturnValue(repo), query: jest.fn().mockResolvedValue(undefined) };
  const dataSource = {
    transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;

  const attendanceClient = { forward: jest.fn() } as unknown as jest.Mocked<AttendanceClockEventClient>;
  const leaveRequestClient = { submit: jest.fn() } as unknown as jest.Mocked<LeaveRequestClient>;
  const marketplaceClaimClient = { claim: jest.fn() } as unknown as jest.Mocked<MarketplaceClaimClient>;
  // Default: geofencing not enabled for the org unit - every pre-Phase-6
  // clock_event test exercises this path unless a test overrides it.
  const geofenceVerification = {
    evaluate: jest.fn().mockResolvedValue({ enabled: false, verified: null, enforcement: null }),
    getConfigForEmployee: jest.fn(),
  } as unknown as jest.Mocked<GeofenceVerificationService>;
  const metrics = new MetricsService();

  const service = new MobileSyncService(
    dataSource,
    attendanceClient,
    leaveRequestClient,
    marketplaceClaimClient,
    geofenceVerification,
    metrics,
  );

  return { repo, attendanceClient, leaveRequestClient, marketplaceClaimClient, geofenceVerification, service };
}
