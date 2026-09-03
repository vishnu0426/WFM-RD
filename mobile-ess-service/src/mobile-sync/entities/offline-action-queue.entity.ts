import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum OfflineActionType {
  CLOCK_EVENT = 'clock_event',
  LEAVE_REQUEST = 'leave_request',
  MARKETPLACE_CLAIM = 'marketplace_claim',
}

export enum OfflineActionStatus {
  PENDING_SYNC = 'pending_sync',
  SYNCED = 'synced',
  FAILED = 'failed',
  CONFLICT = 'conflict',
}

/**
 * Source spec §2.1's exact field set. `id` is CLIENT-generated (the mobile
 * app mints a UUID at queue time) and doubles as the per-action idempotency
 * key (docs/adr/0152) - not a server-assigned `gen_random_uuid()` default,
 * unlike every other entity in this platform.
 *
 * `receivedAt` is an addition beyond the spec's literal field list, same
 * "gained a timestamp even where the field list omitted it" posture Module
 * 02 Phase 1 used (docs/module-02-phase-1-design-doc.md) - the true
 * server-first-saw-this-row time, distinct from both `createdAtDevice`
 * (the sacred, client-captured moment of queuing) and `syncedAt` (when
 * processing against the owning module completed). Mirrors
 * `AttendanceIngestionEvent.receivedAt`'s already-established role.
 */
@Entity({ name: 'offline_action_queue', schema: 'mobile_ess' })
export class OfflineActionQueue {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'tenant_id' }) tenantId!: string;
  @Column('uuid', { name: 'employee_id' }) employeeId!: string;
  @Column('varchar', { name: 'action_type' }) actionType!: OfflineActionType;
  @Column('jsonb') payload!: Record<string, unknown>;
  @Column('varchar', { default: OfflineActionStatus.PENDING_SYNC }) status!: OfflineActionStatus;
  @Column('timestamptz', { name: 'created_at_device' }) createdAtDevice!: Date;
  @Column('timestamptz', { name: 'received_at' }) receivedAt!: Date;
  @Column('timestamptz', { name: 'synced_at', nullable: true }) syncedAt!: Date | null;
  @Column('jsonb', { name: 'conflict_details', nullable: true }) conflictDetails!: Record<string, unknown> | null;
  @Column('boolean', { name: 'geofence_verified', nullable: true }) geofenceVerified!: boolean | null;
}
