import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AttendanceSource } from './attendance-record.entity';

export enum AttendanceClockEventType {
  CLOCK_IN = 'clock_in',
  CLOCK_OUT = 'clock_out',
}

/**
 * Phase 2 (§3.2, ADR-0075): idempotency ledger for
 * `POST .../clock-events` - a Postgres unique constraint on
 * `(tenant_id, source, source_event_id)` stands in for Module 05's
 * Redis `SET...EX...NX` lock (ADR-0062), since this service deliberately
 * has no Redis presence until Phase 4's BullMQ (Phase 1 design doc,
 * explicit assumption 3) and this module's own framing (§0) prioritizes
 * correctness over the sub-millisecond latency Redis exists for. See
 * ADR-0075 for the full contrast.
 *
 * `attendanceRecordId` is always known *before* this row is inserted
 * (generated client-side for a `clock_in`, or the existing open record's id
 * for a `clock_out`) - so this table never needs an UPDATE grant, only
 * INSERT/SELECT/DELETE (DELETE backs the compensating rollback on a
 * downstream failure, `AttendanceIngestionService`'s own doc comment).
 */
@Entity({ name: 'attendance_ingestion_event', schema: 'attendance_leave' })
export class AttendanceIngestionEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'source' })
  source!: AttendanceSource;

  @Column('varchar', { name: 'source_event_id' })
  sourceEventId!: string;

  @Column('varchar', { name: 'event_type' })
  eventType!: AttendanceClockEventType;

  @Column('uuid', { name: 'attendance_record_id' })
  attendanceRecordId!: string;

  @Column('timestamptz', { name: 'received_at' })
  receivedAt!: Date;
}
