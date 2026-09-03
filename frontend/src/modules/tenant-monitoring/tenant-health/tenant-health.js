/* Tenants > Tenant Health — read-only, cross-tenant snapshot (status, tier,
   SSO configured, last login, days since last login), sourced from
   analytics_mv.mv_tenant_health (analytics-reporting-service).
   platform_admin-only; see tenant-monitoring.controller.ts. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { pageHead, empty, fmtDt } from '../../identity-org/shared/ui.js';
import { tenantStatusBadge } from '../tenant-status-badge.js';
import * as TenantMonitoringApi from '../api.js';

function ssoBadge(configured) {
  return configured
    ? `<span class="badge badge-ok"><span class="pip"></span>Configured</span>`
    : `<span class="badge badge-sys"><span class="pip"></span>Not configured</span>`;
}

function staleBadge(days) {
  if (days == null) return `<span class="muted">Never logged in</span>`;
  if (days >= 30) return `<span class="badge badge-danger"><span class="pip"></span>${days}d</span>`;
  if (days >= 14) return `<span class="badge badge-warn"><span class="pip"></span>${days}d</span>`;
  return `<span class="badge badge-ok"><span class="pip"></span>${days}d</span>`;
}

async function loadHealth(state) {
  state.wf.tenantHealth = { loading: true };
  doRerender();
  try {
    const { tenants } = await TenantMonitoringApi.getHealth();
    state.wf.tenantHealth = { tenants };
  } catch (err) {
    state.wf.tenantHealth = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  const cache = state.wf.tenantHealth;
  if (cache === undefined) loadHealth(state);

  const head = pageHead(
    'Tenant Health',
    'Status, tier, SSO configuration, and login recency across every tenant. Refreshed nightly.',
    '',
  );

  if (!cache || cache.loading) {
    return `${head}<div class="panel"><div class="skel" style="height:120px"></div></div>`;
  }
  if (cache.error) {
    return `${head}<div class="panel">${empty('Could not load tenant health.', cache.error)}</div>`;
  }
  if (!cache.tenants.length) {
    return `${head}<div class="panel">${empty('No tenants yet.')}</div>`;
  }

  const rows = cache.tenants
    .map(
      (t) => `
      <tr>
        <td><b>${esc(t.tenantName)}</b></td>
        <td>${tenantStatusBadge(t.status)}</td>
        <td>${esc(t.tier)}</td>
        <td>${fmtDt(t.tenantCreatedAt)}</td>
        <td>${ssoBadge(t.ssoConfigured)}</td>
        <td>${t.lastLoginAt ? fmtDt(t.lastLoginAt) : '<span class="muted">—</span>'}</td>
        <td>${staleBadge(t.daysSinceLastLogin)}</td>
      </tr>`,
    )
    .join('');

  return `
    ${head}
    <div class="panel">
      <div style="overflow-x:auto">
        <table class="data">
          <thead><tr>
            <th>Tenant</th><th>Status</th><th>Tier</th><th>Created</th>
            <th>SSO</th><th>Last login</th><th>Days since login</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

export function handle() {
  return false;
}
