import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AttendanceExceptionType, AttendanceRecord } from './entities/attendance-record.entity';
import { AttendanceClockEventType, AttendanceIngestionEvent } from './entities/attendance-ingestion-event.entity';
import {
  AttendanceExceptionDetectionService,
  ClockInExceptionResult,
  ClockOutExceptionResult,
} from './attendance-exception-detection.service';
import { ClockEventDto } from './dto/clock-event.dto';
import { NoOpenAttendanceRecordError } from '../common/errors/no-open-attendance-record.error';
import { AttendanceRecordConflictError } from '../common/errors/attendance-record-conflict.error';
import { UpstreamUnavailableError } from '../common/errors/upstream-unavailable.error';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { isUniqueViolation } from '../database/postgres-error-codes';

export interface IngestionResult {
  outcome: 'accepted' | 'duplicate';
  attendanceRecordId: string;
}

/**
 * §3.2/ADR-0075: verify (the guard, before this runs) -> dedupe -> write.
 *
 * Every Postgres operation here goes through `withTenantConnection` (own
 * copy of intraday-service's helper) - without it, RLS silently rejects
 * every write and hides every read behind an unset `app.current_tenant_id`
 * GUC.
 *
 * The `AttendanceRecord` write and the `attendance_ingestion_event` ledger
 * insert happen **together, in one transaction** - not the
 * lock-then-release-on-failure shape this class originally shipped with
 * (see ADR-0075's revision history). That first design inserted the
 * ledger row *before* the `AttendanceRecord` it references existed, which
 * cannot coexist with `attendance_ingestion_event`'s real foreign key
 * (caught by this phase's real-Postgres verification, not by unit tests
 * against mocked repositories - a genuine bug in the first cut, not a
 * hypothetical). Combining both writes into one transaction fixes the FK
 * ordering *and* is strictly simpler: a unique-violation on the ledger
 * insert rolls back the `AttendanceRecord` write automatically, so no
 * manual "delete the ledger row to compensate" step is needed at all.
 *
 * The `ScheduleServiceClient` HTTP call that resolves exception info always
 * happens *before* this transaction opens, never inside it - same
 * principle ADR-0074 states for Phase 3's leave-balance lock: a slow
 * `scheduling-service` response must never hold a Postgres transaction (and
 * therefore a unique-constraint row lock) open.
 */
@Injectable()
export class AttendanceIngestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly exceptionDetection: AttendanceExceptionDetectionService,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(tenantId: string, event: ClockEventDto): Promise<IngestionResult> {
    const occurredAt = new Date(event.occurredAt);

    if (event.eventType === AttendanceClockEventType.CLOCK_IN) {
      const attendanceRecordId = randomUUID();
      let exception = await this.resolveClockInException(tenantId, event, occurredAt);
      // Module 11 Phase 6 (docs/adr/0155): only when no other anomaly was
      // already detected - inherits this column's own already-disclosed
      // single-value "first anomaly wins" limitation verbatim, not solved
      // here.
      if (event.geofenceVerified === false && !exception.exceptionType) {
        exception = { ...exception, exceptionType: AttendanceExceptionType.GEOFENCE_VIOLATION };
      }
      return this.commit(tenantId, event, async (manager) => {
        await manager.insert(AttendanceRecord, {
          id: attendanceRecordId,
          tenantId,
          employeeId: event.employeeId,
          clockInAt: occurredAt,
          clockOutAt: null,
          source: event.source,
          scheduledShiftId: exception.scheduledShiftId,
          exceptionType: exception.exceptionType,
          exceptionMinutes: exception.exceptionMinutes,
          geofenceVerified: event.geofenceVerified ?? null,
        });
        return attendanceRecordId;
      });
    }

    const openRecord = await this.findOpenRecord(tenantId, event.employeeId);
    if (!openRecord) {
      this.metrics.recordAttendanceIngestionEvent('rejected');
      throw new NoOpenAttendanceRecordError(event.employeeId);
    }
    let exception = await this.resolveClockOutException(tenantId, event, openRecord, occurredAt);
    // Must also guard on `openRecord.exceptionType` (not just the freshly-
    // resolved `exception.exceptionType`) - `detectForClockOut` already
    // short-circuits to `{exceptionType: null, ...}` whenever the record
    // already carries one, and the update below's `?? openRecord.exceptionType`
    // fallback would otherwise let a geofence flag silently clobber an
    // already-real LATE/UNSCHEDULED_WORK exception set at clock-in.
    if (event.geofenceVerified === false && !exception.exceptionType && !openRecord.exceptionType) {
      exception = { ...exception, exceptionType: AttendanceExceptionType.GEOFENCE_VIOLATION };
    }
    return this.commit(tenantId, event, async (manager) => {
      const result = await manager.update(
        AttendanceRecord,
        { id: openRecord.id, clockOutAt: IsNull() },
        {
          clockOutAt: occurredAt,
          exceptionType: exception.exceptionType ?? openRecord.exceptionType,
          exceptionMinutes: exception.exceptionMinutes ?? openRecord.exceptionMinutes,
          // Same preserve-old-value-when-new-is-null fallback as
          // exceptionType/exceptionMinutes above - a clock-out that
          // doesn't carry a meaningful geofence result (e.g. a transient
          // fail-open at that exact moment) must not erase a real
          // clock-in verification already recorded on this row.
          geofenceVerified: event.geofenceVerified ?? openRecord.geofenceVerified,
        },
      );
      // The record was closed by a concurrent event between findOpenRecord's
      // read and this update - a rare, genuine race (two clock-out taps for
      // the same shift). Thrown inside the transaction, so the ledger
      // insert below never commits either - nothing is left half-written.
      if (!result.affected) {
        throw new AttendanceRecordConflictError(openRecord.id);
      }
      return openRecord.id;
    });
  }

  private async resolveClockInException(
    tenantId: string,
    event: ClockEventDto,
    occurredAt: Date,
  ): Promise<ClockInExceptionResult> {
    try {
      return await this.exceptionDetection.detectForClockIn(tenantId, event.employeeId, occurredAt);
    } catch (err) {
      this.metrics.recordAttendanceIngestionEvent('upstream_unavailable');
      throw new UpstreamUnavailableError('scheduling-service', err);
    }
  }

  private async resolveClockOutException(
    tenantId: string,
    event: ClockEventDto,
    openRecord: AttendanceRecord,
    occurredAt: Date,
  ): Promise<ClockOutExceptionResult> {
    try {
      return await this.exceptionDetection.detectForClockOut(
        tenantId,
        event.employeeId,
        {
          clockInAt: openRecord.clockInAt,
          scheduledShiftId: openRecord.scheduledShiftId,
          exceptionType: openRecord.exceptionType,
        },
        occurredAt,
      );
    } catch (err) {
      this.metrics.recordAttendanceIngestionEvent('upstream_unavailable');
      throw new UpstreamUnavailableError('scheduling-service', err);
    }
  }

  private async findOpenRecord(tenantId: string, employeeId: string): Promise<AttendanceRecord | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AttendanceRecord, {
        where: { tenantId, employeeId, clockOutAt: IsNull() },
        order: { clockInAt: 'DESC' },
      }),
    );
  }

  /**
   * Runs `writeAttendanceRecord` (the insert/update) and the ledger insert
   * in one transaction. `writeAttendanceRecord` returns the
   * `attendanceRecordId` it wrote/updated, so the ledger row's FK target is
   * always already present in the same transaction.
   */
  private async commit(
    tenantId: string,
    event: ClockEventDto,
    writeAttendanceRecord: (manager: EntityManager) => Promise<string>,
  ): Promise<IngestionResult> {
    const start = process.hrtime.bigint();
    try {
      const attendanceRecordId = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        const recordId = await writeAttendanceRecord(manager);
        await manager.insert(AttendanceIngestionEvent, {
          id: randomUUID(),
          tenantId,
          source: event.source,
          sourceEventId: event.sourceEventId,
          eventType: event.eventType,
          attendanceRecordId: recordId,
          receivedAt: new Date(),
        });
        return recordId;
      });
      this.metrics.recordAttendanceIngestionEvent('accepted');
      return { outcome: 'accepted', attendanceRecordId };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await withTenantConnection(this.dataSource, tenantId, (manager) =>
          manager.findOneByOrFail(AttendanceIngestionEvent, {
            tenantId,
            source: event.source,
            sourceEventId: event.sourceEventId,
          }),
        );
        this.metrics.recordAttendanceIngestionEvent('duplicate');
        return { outcome: 'duplicate', attendanceRecordId: existing.attendanceRecordId };
      }
      if (err instanceof AttendanceRecordConflictError) {
        this.metrics.recordAttendanceIngestionEvent('rejected');
        throw err;
      }
      this.metrics.recordAttendanceIngestionEvent('upstream_unavailable');
      throw err;
    } finally {
      this.metrics.observeAttendanceLedgerInsert(secondsSince(start));
    }
  }
}

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
