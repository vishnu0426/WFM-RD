import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * §0.5's progressive-delivery row: "auto-approval of marketplace actions
 * is tenant-configurable and should default to supervisor-approval-required
 * for new tenants, with auto-approval as an explicit opt-in." No
 * tenant-settings table/service exists anywhere in this platform yet to
 * hook a real per-tenant flag into - same explicit, flat-env-config-map
 * placeholder posture Module 05/06 used for their own Phase-1 per-tenant
 * settings (`INTRADAY_WEBHOOK_SECRETS`/`ATTENDANCE_WEBHOOK_SECRETS`): a
 * JSON array of tenant ids that have opted in, defaulting to empty (every
 * tenant defaults to supervisor-approval-required unless explicitly
 * listed) - matching §0.5's own instruction literally, not a considered
 * production tenant-settings design.
 */
@Injectable()
export class TenantMarketplacePolicyService {
  private readonly autoApprovalTenantIds: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const raw = config.get<string>('MARKETPLACE_AUTO_APPROVAL_TENANT_IDS', '[]');
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ids = parsed;
      }
    } catch {
      ids = [];
    }
    this.autoApprovalTenantIds = new Set(ids);
  }

  isAutoApprovalEnabled(tenantId: string): boolean {
    return this.autoApprovalTenantIds.has(tenantId);
  }
}
