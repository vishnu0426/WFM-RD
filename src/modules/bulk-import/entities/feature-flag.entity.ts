import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * §0.5's progressive-delivery requirement: bulk import's destructive
 * (non-dry-run) mode "must ship behind a feature flag... enabled per
 * tenant." Deliberately minimal - a flat `(tenant_id, flag_key) -> enabled`
 * table, not a rules/percentage-rollout engine. `flag_key` is a free
 * string, not an enum: this table is meant to be reusable by any future
 * feature needing per-tenant gating, not just `bulk_import_destructive`
 * (the one key this phase actually uses).
 */
@Entity({ schema: 'org', name: 'feature_flags' })
export class FeatureFlag {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, name: 'flag_key' })
  flagKey!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
