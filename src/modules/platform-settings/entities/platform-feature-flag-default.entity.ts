import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Platform Settings gap-fix: a platform-wide default `enabled` value per
 * `flag_key`, consulted by `FeatureFlagsService.isEnabled()` ONLY when a
 * tenant has no explicit row of its own in `org.feature_flags`
 * (src/modules/bulk-import/entities/feature-flag.entity.ts) — that table's
 * PK is `(tenant_id, flag_key)`, which can't represent a tenant-less
 * default, so this is a separate, new, genuinely global table (no
 * tenant_id, no RLS — same posture as `PlatformSettings`).
 */
@Entity({ schema: 'core', name: 'platform_feature_flag_defaults' })
export class PlatformFeatureFlagDefault {
  @PrimaryColumn({ type: 'varchar', length: 100, name: 'flag_key' })
  flagKey!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
