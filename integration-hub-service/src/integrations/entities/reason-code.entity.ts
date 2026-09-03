import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP3 (plan decision #5). Maps one
 * external ACD/telephony reason code to a tenant-authored WFM activity
 * label (`shiftOperation`) - free text, not an FK, because no canonical
 * Activity/Shift-Operation table exists anywhere in this platform
 * (confirmed by research: intraday-service's `ActivityEvent.currentActivity`
 * is a free string end-to-end, and adherence-compliance-service has no
 * activity enum either). Inventing a fake FK target here would be worse
 * than an honest free-text field.
 *
 * The real downstream effect isn't this table by itself - saving a
 * `ReasonCode` upserts a `FieldMapping` row for the same connector
 * (`targetField: 'currentActivity'`, a `valueMap` entry keyed by
 * `externalId`), the *existing* mechanism real adapters already consume
 * (e.g. `genesys-cloud.adapter.ts`'s `applyFieldMappings`). See
 * `ReasonCodesService.upsertFieldMapping`.
 */
@Entity({ name: 'reason_code', schema: 'integration_hub' })
export class ReasonCode {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'connector_id' })
  connectorId!: string;

  /** The raw code/value the external system emits (e.g. Genesys presence id, Avaya reason code). */
  @Column('varchar', { name: 'external_id', length: 200 })
  externalId!: string;

  /** Tenant-facing label for the reason code itself. */
  @Column('varchar', { name: 'reason_code', length: 200 })
  reasonCode!: string;

  /** Tenant-authored, e.g. "login" | "logout" | "ready" | "not_ready" - no canonical enum exists for this either. */
  @Column('varchar', { name: 'event_mode', length: 50, nullable: true })
  eventMode!: string | null;

  @Column('varchar', { name: 'event_reason', length: 200, nullable: true })
  eventReason!: string | null;

  /** The WFM activity label this reason code represents - becomes the `FieldMapping.transformationRule.valueMap` value written for `externalId`. */
  @Column('varchar', { name: 'shift_operation', length: 200 })
  shiftOperation!: string;

  /** Tenant-authored source label, e.g. "ACD" | "Manual". */
  @Column('varchar', { length: 100, nullable: true })
  origin!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
