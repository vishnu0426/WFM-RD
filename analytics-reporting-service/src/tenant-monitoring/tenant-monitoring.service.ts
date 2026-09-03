import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { ANALYTICS_APP_REPLICA_PG_POOL } from '../database/analytics-app-replica-pool.provider';
import { withPlatformMonitoringScopedClient } from '../database/with-platform-monitoring-scoped-client';

export interface OnboardingFunnelTenant {
  tenantId: string;
  tenantName: string;
  status: string;
  milestones: Record<string, string | null>;
}

export interface TenantHealthRow {
  tenantId: string;
  tenantName: string;
  status: string;
  tier: string;
  tenantCreatedAt: string;
  ssoConfigured: boolean;
  lastLoginAt: string | null;
  daysSinceLastLogin: number | null;
}

const MILESTONE_ORDER = [
  'tenant_provisioned',
  'admin_provisioned',
  'user_invited',
  'invite_accepted',
  'sso_configured',
  'first_login',
];

interface FunnelRow {
  tenant_id: string;
  tenant_name: string;
  status: string;
  milestone: string | null;
  first_occurred_at: Date | null;
}

interface HealthRow {
  tenant_id: string;
  tenant_name: string;
  status: string;
  tier: string;
  tenant_created_at: Date;
  sso_configured: boolean;
  last_login_at: Date | null;
  days_since_last_login: string | null;
}

/**
 * Tenant Monitoring dashboard (internal CS tool): reads the two
 * `analytics_mv.*` rollup tables `1700010000000-TenantMonitoringRollupTables.ts`
 * adds, via `withPlatformMonitoringScopedClient` (the only thing that makes
 * these queries see every tenant's rows, not just one - see that helper's
 * own doc comment). Deliberately its own service, not routed through
 * `MetricQueryEngineService` - that engine's `SOURCE_VIEW_REGISTRY`
 * whitelist is built for single-value-per-dimension time-series metrics,
 * not row-per-tenant listings, and is itself always single-tenant-scoped.
 */
@Injectable()
export class TenantMonitoringService {
  constructor(@Inject(ANALYTICS_APP_REPLICA_PG_POOL) private readonly replicaPool: Pool) {}

  async getOnboardingFunnel(): Promise<OnboardingFunnelTenant[]> {
    const rows = await withPlatformMonitoringScopedClient(this.replicaPool, async (client) => {
      const { rows } = await client.query<FunnelRow>(`
        SELECT h.tenant_id, h.tenant_name, h.status, m.milestone, m.first_occurred_at
        FROM analytics_mv.mv_tenant_health h
        LEFT JOIN analytics_mv.mv_tenant_onboarding_milestones m ON m.tenant_id = h.tenant_id
        ORDER BY h.tenant_name;
      `);
      return rows;
    });

    const byTenant = new Map<string, OnboardingFunnelTenant>();
    for (const row of rows) {
      let tenant = byTenant.get(row.tenant_id);
      if (!tenant) {
        tenant = {
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          status: row.status,
          milestones: Object.fromEntries(MILESTONE_ORDER.map((m) => [m, null])),
        };
        byTenant.set(row.tenant_id, tenant);
      }
      if (row.milestone && row.first_occurred_at) {
        tenant.milestones[row.milestone] = row.first_occurred_at.toISOString();
      }
    }
    return [...byTenant.values()];
  }

  async getHealth(): Promise<TenantHealthRow[]> {
    const rows = await withPlatformMonitoringScopedClient(this.replicaPool, async (client) => {
      const { rows } = await client.query<HealthRow>(`
        SELECT
          tenant_id, tenant_name, status, tier, tenant_created_at, sso_configured, last_login_at,
          CASE WHEN last_login_at IS NULL THEN NULL
               ELSE EXTRACT(DAY FROM now() - last_login_at) END AS days_since_last_login
        FROM analytics_mv.mv_tenant_health
        ORDER BY tenant_name;
      `);
      return rows;
    });

    return rows.map((row) => ({
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      status: row.status,
      tier: row.tier,
      tenantCreatedAt: row.tenant_created_at.toISOString(),
      ssoConfigured: row.sso_configured,
      lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
      daysSinceLastLogin: row.days_since_last_login == null ? null : Number(row.days_since_last_login),
    }));
  }
}
