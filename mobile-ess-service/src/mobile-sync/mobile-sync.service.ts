import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../database/postgres-error-codes';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MobileSyncActionDto } from './dto/mobile-sync-batch-request.dto';
import { OfflineActionQueue, OfflineActionStatus, OfflineActionType } from './entities/offline-action-queue.entity';
import { ClockEventConflictError } from './errors/clock-event-conflict.error';
import { ClockEventForwardFailedError } from './errors/clock-event-forward-failed.error';
import { ClockEventGeofenceViolationError } from './errors/clock-event-geofence-violation.error';
import { LeaveRequestConflictError } from './errors/leave-request-conflict.error';
import { LeaveRequestForwardFailedError } from './errors/leave-request-forward-failed.error';
import { MarketplaceClaimConflictError } from './errors/marketplace-claim-conflict.error';
import { MarketplaceClaimForwardFailedError } from './errors/marketplace-claim-forward-failed.error';
import { AttendanceClockEventClient } from './providers/attendance-clock-event-client';
import { LeaveRequestClient } from './providers/leave-request-client';
import { MarketplaceClaimClient } from './providers/marketplace-claim-client';
import { MetricsService } from '../common/metrics/metrics.service';
import { Coordinates } from '../geofence/haversine-distance';
import { GeofenceVerificationService } from '../geofence/geofence-verification.service';

export interface MobileSyncActionResult {
  actionId: string;
  actionType: OfflineActionType;
  status: 'synced' | 'failed' | 'conflict';
  conflictDetails?: Record<string, unknown>;
  detail?: string;
}

/**
 * §2.2 rule 3: reuses attendance-leave-service's real ingestion pipeline,
 * never a simplified mobile-specific approximation. Processes a batch
 * **sequentially, in array order** - NOT `Promise.all` - deliberately: a
 * batch containing a `clock_in` followed later by a `clock_out` for the
 * same employee (the normal end-of-offline-shift case) would otherwise
 * race the clock-out's open-record read against the clock-in's still-open
 * transaction, producing a spurious conflict. The client sends actions in
 * `createdAtDevice` order (`mobile-app/src/offlineQueue/syncEngine.ts`).
 *
 * GAP-16 fix (enterprise readiness audit, 2026-08-18): every query now goes
 * through `withTenantConnection` - see that helper's own doc comment for
 * why a plain injected `Repository` against this RLS-enabled table was a
 * real, previously-undetected bug (every read returned zero rows, every
 * write was rejected), not just a missing defense-in-depth layer. Each
 * `this.repo.save(row)` call becomes its own short `withTenantConnection`
 * transaction rather than one transaction spanning all of `processAction` -
 * the external gRPC/HTTP calls in between (`attendanceClient.forward`,
 * `leaveRequestClient.submit`, `marketplaceClaimClient.claim`) must never
 * hold a Postgres transaction open, same principle
 * `attendance-ingestion.service.ts` documents for its own leave-balance
 * lock.
 */
@Injectable()
export class MobileSyncService {
  private readonly logger = new Logger(MobileSyncService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly attendanceClient: AttendanceClockEventClient,
    private readonly leaveRequestClient: LeaveRequestClient,
    private readonly marketplaceClaimClient: MarketplaceClaimClient,
    private readonly geofenceVerification: GeofenceVerificationService,
    private readonly metrics: MetricsService,
  ) {}

  async syncBatch(tenantId: string, actions: MobileSyncActionDto[]): Promise<MobileSyncActionResult[]> {
    this.metrics.recordSyncBatchSize(actions.length);
    const results: MobileSyncActionResult[] = [];
    for (const action of actions) {
      results.push(await this.processAction(tenantId, action));
    }
    return results;
  }

  private async processAction(tenantId: string, action: MobileSyncActionDto): Promise<MobileSyncActionResult> {
    let row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(OfflineActionQueue).findOne({ where: { id: action.id, tenantId } }),
    );

    if (row && this.isTerminal(row.status)) {
      return this.toResult(row);
    }

    // ADR-0155: raw location is extracted from the request DTO here, used
    // only transiently for this call's geofence evaluation, and NEVER
    // included in what gets persisted to `payload` below - the client
    // re-sends it on every sync attempt (it's not stored server-side
    // between retries), and `stripLocation` guarantees the persisted jsonb
    // never contains it even on the very first insert.
    const rawLocation =
      action.actionType === OfflineActionType.CLOCK_EVENT
        ? (action.payload as { location?: Coordinates }).location
        : undefined;

    if (!row) {
      try {
        row = await withTenantConnection(this.dataSource, tenantId, (manager) => {
          const repo = manager.getRepository(OfflineActionQueue);
          return repo.save(
            repo.create({
              id: action.id,
              tenantId,
              employeeId: action.employeeId,
              actionType: action.actionType,
              payload: this.stripLocation(action.payload),
              status: OfflineActionStatus.PENDING_SYNC,
              createdAtDevice: new Date(action.createdAtDevice),
              receivedAt: new Date(),
              syncedAt: null,
              conflictDetails: null,
              geofenceVerified: null,
            }),
          );
        });
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw err;
        }
        // A genuinely concurrent request for this same not-yet-existing id
        // (e.g. a reconnect handler and an app-foreground handler both
        // firing sync at once) beat us to the insert. Reload and proceed
        // from whatever state it's actually in - same pattern
        // attendance-ingestion.service.ts already uses for its own dedup.
        row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).findOneOrFail({ where: { id: action.id, tenantId } }),
        );
        if (this.isTerminal(row.status)) {
          return this.toResult(row);
        }
      }
    }

    return this.processByActionType(row, rawLocation);
  }

  /** Deletes the key entirely rather than setting it to `undefined` -
   * guarantees `location` is genuinely absent from the persisted jsonb,
   * not round-tripped as an explicit null depending on serialization
   * (ADR-0155). No-op for action types that never carry a `location` key. */
  private stripLocation(payload: Record<string, unknown>): Record<string, unknown> {
    if (!('location' in payload)) {
      return payload;
    }
    const rest = { ...payload };
    delete rest.location;
    return rest;
  }

  private isTerminal(status: OfflineActionStatus): boolean {
    return status === OfflineActionStatus.SYNCED || status === OfflineActionStatus.CONFLICT;
  }

  private toResult(row: OfflineActionQueue): MobileSyncActionResult {
    if (row.status === OfflineActionStatus.CONFLICT) {
      return {
        actionId: row.id,
        actionType: row.actionType,
        status: 'conflict',
        conflictDetails: row.conflictDetails ?? undefined,
      };
    }
    if (row.status === OfflineActionStatus.SYNCED) {
      return { actionId: row.id, actionType: row.actionType, status: 'synced' };
    }
    return { actionId: row.id, actionType: row.actionType, status: 'failed' };
  }

  private async processByActionType(row: OfflineActionQueue, location?: Coordinates): Promise<MobileSyncActionResult> {
    switch (row.actionType) {
      case OfflineActionType.CLOCK_EVENT:
        return this.processClockEvent(row, location);
      case OfflineActionType.LEAVE_REQUEST:
        return this.processLeaveRequest(row);
      case OfflineActionType.MARKETPLACE_CLAIM:
        return this.processMarketplaceClaim(row);
      default:
        // Unreachable given today's 3-value enum - a safety net for a
        // future action type added to the DB CHECK constraint without a
        // matching handler here, rather than a silent crash.
        row.status = OfflineActionStatus.FAILED;
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(row.actionType, 'failed');
        return {
          actionId: row.id,
          actionType: row.actionType,
          status: 'failed',
          detail: `${row.actionType} is not yet supported by this phase.`,
        };
    }
  }

  private async processClockEvent(row: OfflineActionQueue, location?: Coordinates): Promise<MobileSyncActionResult> {
    const payload = row.payload as { eventType?: string };
    if (payload.eventType !== 'clock_in' && payload.eventType !== 'clock_out') {
      row.status = OfflineActionStatus.FAILED;
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.CLOCK_EVENT, 'failed');
      return {
        actionId: row.id,
        actionType: row.actionType,
        status: 'failed',
        detail: 'payload.eventType must be clock_in or clock_out.',
      };
    }

    try {
      const geofence = await this.geofenceVerification.evaluate(row.tenantId, row.employeeId, location);

      // ADR-0155: hard enforcement short-circuits before attendance-leave-
      // service is ever called - this service already has everything it
      // needs (the boundary + the computed distance) to decide this
      // locally, same as it already decides `failed` vs `conflict` today
      // without attendance-leave-service's help.
      if (geofence.enabled && geofence.enforcement === 'hard' && geofence.verified === false) {
        throw new ClockEventGeofenceViolationError();
      }

      await this.attendanceClient.forward({
        tenantId: row.tenantId,
        sourceEventId: row.id,
        employeeId: row.employeeId,
        eventType: payload.eventType,
        // The exact instant captured at queue time, threaded through
        // unchanged - never sync time (docs/adr/0152's non-negotiable).
        occurredAt: row.createdAtDevice.toISOString(),
        geofenceVerified: geofence.verified,
      });

      row.status = OfflineActionStatus.SYNCED;
      row.syncedAt = new Date();
      // Spec's literal "store the result (OfflineActionQueue.geofence_verified...
      // an equivalent field on the live clock-in path)" - satisfied from
      // the one computation above, threaded to both places.
      row.geofenceVerified = geofence.verified;
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.CLOCK_EVENT, 'synced');
      return { actionId: row.id, actionType: row.actionType, status: 'synced' };
    } catch (err) {
      if (err instanceof ClockEventGeofenceViolationError) {
        row.status = OfflineActionStatus.CONFLICT;
        row.geofenceVerified = false;
        row.conflictDetails = { code: 'GEOFENCE_VIOLATION', message: err.message };
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.CLOCK_EVENT, 'conflict');
        return {
          actionId: row.id,
          actionType: row.actionType,
          status: 'conflict',
          conflictDetails: row.conflictDetails,
        };
      }

      if (err instanceof ClockEventConflictError) {
        row.status = OfflineActionStatus.CONFLICT;
        row.conflictDetails = { code: err.upstreamCode, message: err.message };
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.CLOCK_EVENT, 'conflict');
        return {
          actionId: row.id,
          actionType: row.actionType,
          status: 'conflict',
          conflictDetails: row.conflictDetails,
        };
      }

      if (err instanceof ClockEventForwardFailedError) {
        row.status = OfflineActionStatus.FAILED;
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.CLOCK_EVENT, 'failed');
        if (err.httpStatus === 401) {
          // A real HMAC-secret misconfiguration between this service and
          // attendance-leave-service, not a user problem - loud, not a
          // quiet per-action failure.
          this.logger.error(
            `HMAC rejected calling attendance-leave-service for action ${row.id} (tenant ${row.tenantId}) - check ATTENDANCE_LEAVE_INGESTION_HMAC_SECRETS: ${err.message}`,
          );
        }
        return { actionId: row.id, actionType: row.actionType, status: 'failed', detail: err.message };
      }

      throw err;
    }
  }

  /**
   * §2.2 rule 3: reuses attendance-leave-service's real `LeaveConflictCheckService`
   * pipeline (docs/adr/0153). Note a detected schedule conflict there is a
   * SOFT jsonb annotation on a successful `LeaveRequest`, never a
   * rejection - a successful call here is always `synced`, regardless of
   * `conflictFlags`. `conflict`/`failed` come only from
   * `LeaveRequestClient`'s own error mapping (docs/adr/0153's explicit
   * rule: won't-succeed-unmodified vs plausibly-transient).
   */
  private async processLeaveRequest(row: OfflineActionQueue): Promise<MobileSyncActionResult> {
    const payload = row.payload as { leaveTypeId?: string; dateRangeStart?: string; dateRangeEnd?: string };
    if (!payload.leaveTypeId || !payload.dateRangeStart || !payload.dateRangeEnd) {
      row.status = OfflineActionStatus.FAILED;
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.LEAVE_REQUEST, 'failed');
      return {
        actionId: row.id,
        actionType: row.actionType,
        status: 'failed',
        detail: 'payload must include leaveTypeId, dateRangeStart, and dateRangeEnd.',
      };
    }

    try {
      await this.leaveRequestClient.submit({
        tenantId: row.tenantId,
        employeeId: row.employeeId,
        leaveTypeId: payload.leaveTypeId,
        dateRangeStart: payload.dateRangeStart,
        dateRangeEnd: payload.dateRangeEnd,
      });

      row.status = OfflineActionStatus.SYNCED;
      row.syncedAt = new Date();
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.LEAVE_REQUEST, 'synced');
      return { actionId: row.id, actionType: row.actionType, status: 'synced' };
    } catch (err) {
      if (err instanceof LeaveRequestConflictError) {
        row.status = OfflineActionStatus.CONFLICT;
        row.conflictDetails = { code: err.upstreamCode, message: err.message };
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.LEAVE_REQUEST, 'conflict');
        return {
          actionId: row.id,
          actionType: row.actionType,
          status: 'conflict',
          conflictDetails: row.conflictDetails,
        };
      }

      if (err instanceof LeaveRequestForwardFailedError) {
        row.status = OfflineActionStatus.FAILED;
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.LEAVE_REQUEST, 'failed');
        return { actionId: row.id, actionType: row.actionType, status: 'failed', detail: err.message };
      }

      throw err;
    }
  }

  /**
   * §2.2 rule 3: reuses shift-marketplace-service's real
   * `ClaimOpenShiftService.claim()` concurrency-safe flow (docs/adr/0153).
   * `MarketplaceClaimClient` itself already folds the "200 with no
   * GraphQL errors but `claim.status === 'rejected'`" case into
   * `MarketplaceClaimConflictError` - this method doesn't need its own
   * awareness of that nuance, only the client does.
   */
  private async processMarketplaceClaim(row: OfflineActionQueue): Promise<MobileSyncActionResult> {
    const payload = row.payload as { marketplacePostId?: string };
    if (!payload.marketplacePostId) {
      row.status = OfflineActionStatus.FAILED;
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.MARKETPLACE_CLAIM, 'failed');
      return {
        actionId: row.id,
        actionType: row.actionType,
        status: 'failed',
        detail: 'payload must include marketplacePostId.',
      };
    }

    try {
      await this.marketplaceClaimClient.claim({
        tenantId: row.tenantId,
        employeeId: row.employeeId,
        marketplacePostId: payload.marketplacePostId,
      });

      row.status = OfflineActionStatus.SYNCED;
      row.syncedAt = new Date();
      await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
        manager.getRepository(OfflineActionQueue).save(row),
      );
      this.metrics.recordSyncAction(OfflineActionType.MARKETPLACE_CLAIM, 'synced');
      return { actionId: row.id, actionType: row.actionType, status: 'synced' };
    } catch (err) {
      if (err instanceof MarketplaceClaimConflictError) {
        row.status = OfflineActionStatus.CONFLICT;
        row.conflictDetails = { code: err.upstreamCode, message: err.message };
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.MARKETPLACE_CLAIM, 'conflict');
        return {
          actionId: row.id,
          actionType: row.actionType,
          status: 'conflict',
          conflictDetails: row.conflictDetails,
        };
      }

      if (err instanceof MarketplaceClaimForwardFailedError) {
        row.status = OfflineActionStatus.FAILED;
        await withTenantConnection(this.dataSource, row.tenantId, (manager) =>
          manager.getRepository(OfflineActionQueue).save(row),
        );
        this.metrics.recordSyncAction(OfflineActionType.MARKETPLACE_CLAIM, 'failed');
        return { actionId: row.id, actionType: row.actionType, status: 'failed', detail: err.message };
      }

      throw err;
    }
  }
}
