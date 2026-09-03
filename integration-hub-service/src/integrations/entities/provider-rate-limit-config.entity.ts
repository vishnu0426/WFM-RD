import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1/§5a/§5c, ADR-0136: platform-operator-maintained reference data, no
 * `tenantId`, no RLS - seeded/updated by `agno_migrator`, never written by
 * the running application (`agno_integration_hub_app` has `SELECT` only on
 * this table). Seed values and sourcing are tracked in
 * `docs/module-12-provider-research.md`, not inline here.
 *
 * `concurrentRequestLimit` is repurposed per provider for streaming (ACD)
 * connectors - "max concurrent monitored links/sessions" rather than a
 * request-count ceiling (ADR-0135). The column stays a plain nullable
 * non-negative integer either way; only its meaning differs by provider.
 */
@Entity({ name: 'provider_rate_limit_config', schema: 'integration_hub' })
export class ProviderRateLimitConfig {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar')
  provider!: string;

  @Column('integer', { name: 'requests_per_window', nullable: true })
  requestsPerWindow!: number | null;

  @Column('integer', { name: 'window_seconds', nullable: true })
  windowSeconds!: number | null;

  @Column('integer', { name: 'concurrent_request_limit', nullable: true })
  concurrentRequestLimit!: number | null;

  @Column('jsonb', { name: 'backoff_strategy', default: {} })
  backoffStrategy!: Record<string, unknown>;
}
