import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum DeviceType {
  IOS = 'ios',
  ANDROID = 'android',
}

/**
 * Source spec §2.1's `DeviceRegistration` DDL, Phase 5 (ADR-0154). Unlike
 * `OfflineActionQueue.id`, `id` here IS server-assigned
 * (`gen_random_uuid()`) - the real upsert key is the composite unique
 * constraint `(tenant_id, employee_id, device_type, device_id)`, not `id`
 * itself. `device_id` (ADR-0150/ADR-0157, Module 11 Gap 2) closes
 * ADR-0154's original judgment call - the spec's DDL had no
 * device-identifier column, so one row per employee per platform was the
 * only key it could support, meaning a second same-platform device
 * silently overwrote the first's token. `device_id` is `mobile-app`'s own
 * stable per-install id (`src/lib/deviceId.ts`), opaque here.
 *
 * `active`/`createdAt` are additions beyond the spec's literal field list,
 * same "gained a field the list omitted" posture ADR-0151 used for
 * `receivedAt` - `active` is the soft dead-token flag (ADR-0154 §6, no
 * DELETE grant on this table).
 */
@Entity({ name: 'device_registration', schema: 'mobile_ess' })
export class DeviceRegistration {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column('uuid', { name: 'tenant_id' }) tenantId!: string;
  @Column('uuid', { name: 'employee_id' }) employeeId!: string;
  @Column('varchar', { name: 'device_type' }) deviceType!: DeviceType;
  @Column('varchar', { name: 'device_id' }) deviceId!: string;
  @Column('varchar', { name: 'push_token' }) pushToken!: string;
  @Column('varchar', { name: 'app_version' }) appVersion!: string;
  @Column('boolean', { name: 'biometric_enrolled', default: false }) biometricEnrolled!: boolean;
  @Column('boolean', { default: true }) active!: boolean;
  @Column('timestamptz', { name: 'last_active_at' }) lastActiveAt!: Date;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
