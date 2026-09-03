import { DataSource, EntityManager } from 'typeorm';
import { AttendanceIngestionService } from '../../../src/attendance/attendance-ingestion.service';
import { AttendanceExceptionDetectionService } from '../../../src/attendance/attendance-exception-detection.service';
import {
  AttendanceExceptionType,
  AttendanceRecord,
  AttendanceSource,
} from '../../../src/attendance/entities/attendance-record.entity';
import {
  AttendanceClockEventType,
  AttendanceIngestionEvent,
} from '../../../src/attendance/entities/attendance-ingestion-event.entity';
import { ClockEventDto } from '../../../src/attendance/dto/clock-event.dto';
import { NoOpenAttendanceRecordError } from '../../../src/common/errors/no-open-attendance-record.error';
import { AttendanceRecordConflictError } from '../../../src/common/errors/attendance-record-conflict.error';
import { UpstreamUnavailableError } from '../../../src/common/errors/upstream-unavailable.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

/**
 * `AttendanceIngestionService` routes every write through
 * `withTenantConnection` (`dataSource.transaction(...)`, see that helper's
 * own doc comment on why - RLS's `app.current_tenant_id` GUC). This test
 * fakes `DataSource.transaction` to invoke the callback with a mocked
 * `EntityManager`, so these assertions exercise the real service logic
 * (the single-transaction ledger+record write, dedup detection, the
 * clock-out conflict check) without a live Postgres - the RLS/FK wiring
 * itself is covered by the Phase 2 design doc's real-Postgres verification
 * (which is exactly what caught the first cut's FK-ordering bug this
 * revised design fixes).
 */
describe('AttendanceIngestionService', () => {
  let manager: jest.Mocked<Pick<EntityManager, 'insert' | 'update' | 'findOne' | 'findOneByOrFail' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let exceptionDetection: jest.Mocked<
    Pick<AttendanceExceptionDetectionService, 'detectForClockIn' | 'detectForClockOut'>
  >;
  let metrics: MetricsService;
  let service: AttendanceIngestionService;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const clockInEvent: ClockEventDto = Object.assign(new ClockEventDto(), {
    sourceEventId: 'device-evt-1',
    employeeId: '22222222-2222-2222-2222-222222222222',
    eventType: AttendanceClockEventType.CLOCK_IN,
    occurredAt: '2026-01-05T09:00:00.000Z',
    source: AttendanceSource.BADGE,
  });

  beforeEach(() => {
    manager = {
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    exceptionDetection = { detectForClockIn: jest.fn(), detectForClockOut: jest.fn() };
    metrics = new MetricsService();
    service = new AttendanceIngestionService(
      dataSource as DataSource,
      exceptionDetection as unknown as AttendanceExceptionDetectionService,
      metrics,
    );
  });

  it('accepts a fresh clock_in: writes the AttendanceRecord and the ledger row in the same transaction', async () => {
    exceptionDetection.detectForClockIn.mockResolvedValue({
      scheduledShiftId: 'shift-1',
      exceptionType: AttendanceExceptionType.LATE,
      exceptionMinutes: 15,
    });

    const result = await service.ingest(tenantId, clockInEvent);

    expect(result.outcome).toBe('accepted');
    expect(manager.insert).toHaveBeenCalledWith(
      AttendanceRecord,
      expect.objectContaining({
        id: result.attendanceRecordId,
        exceptionType: AttendanceExceptionType.LATE,
        exceptionMinutes: 15,
      }),
    );
    expect(manager.insert).toHaveBeenCalledWith(
      AttendanceIngestionEvent,
      expect.objectContaining({
        attendanceRecordId: result.attendanceRecordId,
        sourceEventId: clockInEvent.sourceEventId,
      }),
    );
    // AttendanceRecord must be written before the ledger row references it (FK ordering within the transaction).
    const recordCallOrder = manager.insert.mock.invocationCallOrder[0];
    const ledgerCallOrder = manager.insert.mock.invocationCallOrder[1];
    expect(recordCallOrder).toBeLessThan(ledgerCallOrder);
  });

  it('reports a duplicate on a unique-violation, resolving the already-committed ledger row', async () => {
    exceptionDetection.detectForClockIn.mockResolvedValue({
      scheduledShiftId: null,
      exceptionType: null,
      exceptionMinutes: null,
    });
    manager.insert.mockImplementationOnce(async () => ({}) as never); // AttendanceRecord insert succeeds
    manager.insert.mockImplementationOnce(async () => {
      throw uniqueViolation();
    }); // ledger insert hits the unique constraint
    manager.findOneByOrFail.mockResolvedValue({ attendanceRecordId: 'existing-record-id' } as AttendanceIngestionEvent);

    const result = await service.ingest(tenantId, clockInEvent);

    expect(result).toEqual({ outcome: 'duplicate', attendanceRecordId: 'existing-record-id' });
  });

  it('surfaces UpstreamUnavailableError when scheduling-service is unreachable, without ever opening a transaction', async () => {
    exceptionDetection.detectForClockIn.mockRejectedValue(new Error('scheduling-service is down'));

    await expect(service.ingest(tenantId, clockInEvent)).rejects.toThrow(UpstreamUnavailableError);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a clock_out with no open AttendanceRecord, without calling scheduling-service or opening a write transaction', async () => {
    const clockOutEvent = Object.assign(new ClockEventDto(), {
      ...clockInEvent,
      eventType: AttendanceClockEventType.CLOCK_OUT,
    });
    manager.findOne.mockResolvedValue(null);

    await expect(service.ingest(tenantId, clockOutEvent)).rejects.toThrow(NoOpenAttendanceRecordError);
    expect(exceptionDetection.detectForClockOut).not.toHaveBeenCalled();
  });

  it('closes the open record on clock_out and raises a conflict if it was closed concurrently (rolling back the ledger insert too)', async () => {
    const clockOutEvent = Object.assign(new ClockEventDto(), {
      ...clockInEvent,
      eventType: AttendanceClockEventType.CLOCK_OUT,
    });
    const openRecord = {
      id: 'open-record-id',
      clockInAt: new Date('2026-01-05T09:00:00.000Z'),
      scheduledShiftId: 'shift-1',
      exceptionType: null,
      exceptionMinutes: null,
    } as AttendanceRecord;
    manager.findOne.mockResolvedValue(openRecord);
    exceptionDetection.detectForClockOut.mockResolvedValue({ exceptionType: null, exceptionMinutes: null });
    manager.update.mockResolvedValue({ affected: 0 } as never);

    await expect(service.ingest(tenantId, clockOutEvent)).rejects.toThrow(AttendanceRecordConflictError);
    // The ledger insert must never run once the update reports no affected rows.
    expect(manager.insert).not.toHaveBeenCalledWith(AttendanceIngestionEvent, expect.anything());
  });

  describe('geofencing (Module 11 Phase 6, docs/adr/0155)', () => {
    it('records geofenceVerified as-is on the AttendanceRecord, never recomputing it', async () => {
      exceptionDetection.detectForClockIn.mockResolvedValue({
        scheduledShiftId: 'shift-1',
        exceptionType: null,
        exceptionMinutes: null,
      });
      const event = Object.assign(new ClockEventDto(), { ...clockInEvent, geofenceVerified: true });

      await service.ingest(tenantId, event);

      expect(manager.insert).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.objectContaining({ geofenceVerified: true }),
      );
    });

    it('flags GEOFENCE_VIOLATION on clock_in when geofenceVerified is false and no other exception was detected', async () => {
      exceptionDetection.detectForClockIn.mockResolvedValue({
        scheduledShiftId: 'shift-1',
        exceptionType: null,
        exceptionMinutes: null,
      });
      const event = Object.assign(new ClockEventDto(), { ...clockInEvent, geofenceVerified: false });

      await service.ingest(tenantId, event);

      expect(manager.insert).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.objectContaining({
          exceptionType: AttendanceExceptionType.GEOFENCE_VIOLATION,
          geofenceVerified: false,
        }),
      );
    });

    it('does not overwrite an already-detected clock_in exception with GEOFENCE_VIOLATION (single-column, first-anomaly-wins)', async () => {
      exceptionDetection.detectForClockIn.mockResolvedValue({
        scheduledShiftId: 'shift-1',
        exceptionType: AttendanceExceptionType.LATE,
        exceptionMinutes: 15,
      });
      const event = Object.assign(new ClockEventDto(), { ...clockInEvent, geofenceVerified: false });

      await service.ingest(tenantId, event);

      expect(manager.insert).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.objectContaining({ exceptionType: AttendanceExceptionType.LATE, geofenceVerified: false }),
      );
    });

    it('flags GEOFENCE_VIOLATION on clock_out when geofenceVerified is false and the open record had no exception', async () => {
      const clockOutEvent = Object.assign(new ClockEventDto(), {
        ...clockInEvent,
        eventType: AttendanceClockEventType.CLOCK_OUT,
        geofenceVerified: false,
      });
      const openRecord = {
        id: 'open-record-id',
        clockInAt: new Date('2026-01-05T09:00:00.000Z'),
        scheduledShiftId: 'shift-1',
        exceptionType: null,
        exceptionMinutes: null,
        geofenceVerified: true,
      } as AttendanceRecord;
      manager.findOne.mockResolvedValue(openRecord);
      exceptionDetection.detectForClockOut.mockResolvedValue({ exceptionType: null, exceptionMinutes: null });
      manager.update.mockResolvedValue({ affected: 1 } as never);

      await service.ingest(tenantId, clockOutEvent);

      expect(manager.update).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.anything(),
        expect.objectContaining({ exceptionType: AttendanceExceptionType.GEOFENCE_VIOLATION, geofenceVerified: false }),
      );
    });

    it('does not overwrite an exception already set at clock_in when clock_out reports a geofence violation', async () => {
      const clockOutEvent = Object.assign(new ClockEventDto(), {
        ...clockInEvent,
        eventType: AttendanceClockEventType.CLOCK_OUT,
        geofenceVerified: false,
      });
      const openRecord = {
        id: 'open-record-id',
        clockInAt: new Date('2026-01-05T09:00:00.000Z'),
        scheduledShiftId: 'shift-1',
        exceptionType: AttendanceExceptionType.UNSCHEDULED_WORK,
        exceptionMinutes: null,
        geofenceVerified: null,
      } as AttendanceRecord;
      manager.findOne.mockResolvedValue(openRecord);
      exceptionDetection.detectForClockOut.mockResolvedValue({ exceptionType: null, exceptionMinutes: null });
      manager.update.mockResolvedValue({ affected: 1 } as never);

      await service.ingest(tenantId, clockOutEvent);

      expect(manager.update).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.anything(),
        expect.objectContaining({ exceptionType: AttendanceExceptionType.UNSCHEDULED_WORK }),
      );
    });

    it('preserves the record’s existing geofenceVerified on clock_out when the event carries no meaningful value', async () => {
      const clockOutEvent = Object.assign(new ClockEventDto(), {
        ...clockInEvent,
        eventType: AttendanceClockEventType.CLOCK_OUT,
        geofenceVerified: null,
      });
      const openRecord = {
        id: 'open-record-id',
        clockInAt: new Date('2026-01-05T09:00:00.000Z'),
        scheduledShiftId: 'shift-1',
        exceptionType: null,
        exceptionMinutes: null,
        geofenceVerified: true,
      } as AttendanceRecord;
      manager.findOne.mockResolvedValue(openRecord);
      exceptionDetection.detectForClockOut.mockResolvedValue({ exceptionType: null, exceptionMinutes: null });
      manager.update.mockResolvedValue({ affected: 1 } as never);

      await service.ingest(tenantId, clockOutEvent);

      expect(manager.update).toHaveBeenCalledWith(
        AttendanceRecord,
        expect.anything(),
        expect.objectContaining({ geofenceVerified: true }),
      );
    });
  });
});
