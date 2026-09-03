/* Tenants > Onboarding Funnel — read-only, cross-tenant timeline of the six
   setup milestones every tenant passes through, sourced from
   analytics_mv.mv_tenant_onboarding_milestones (analytics-reporting-
   service). platform_admin-only; see tenant-monitoring.controller.ts. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { pageHead, empty, fmtDt } from '../../identity-org/shared/ui.js';
import { tenantStatusBadge } from '../tenant-status-badge.js';
import * as TenantMonitoringApi from '../api.js';

const MILESTONES = [
  { key: 'tenant_provisioned', label: 'Tenant created' },
  { key: 'admin_provisioned', label: 'Admin provisioned' },
  { key: 'user_invited', label: 'Users invited' },
  { key: 'invite_accepted', label: 'Invite accepted' },
  { key: 'sso_configured', label: 'SSO/SCIM configured' },
  { key: 'first_login', label: 'First login' },
];

async function loadFunnel(state) {
  state.wf.tenantOnboardingFunnel = { loading: true };
  doRerender();
  try {
    const { tenants } = await TenantMonitoringApi.getOnboardingFunnel();
    state.wf.tenantOnboardingFunnel = { tenants };
  } catch (err) {
    state.wf.tenantOnboardingFunnel = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  const cache = state.wf.tenantOnboardingFunnel;
  if (cache === undefined) loadFunnel(state);

  const head = pageHead(
    'Onboarding Funnel',
    'First-occurrence timestamp of each setup milestone, across every tenant. Refreshed nightly from the audit log.',
    '',
  );

  if (!cache || cache.loading) {
    return `${head}<div class="panel"><div class="skel" style="height:120px"></div></div>`;
  }
  if (cache.error) {
    return `${head}<div class="panel">${empty('Could not load the onboarding funnel.', cache.error)}</div>`;
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
        ${MILESTONES.map((m) => `<td>${t.milestones[m.key] ? fmtDt(t.milestones[m.key]) : '<span class="muted">—</span>'}</td>`).join('')}
      </tr>`,
    )
    .join('');

  return `
    ${head}
    <div class="panel">
      <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Tenant</th><th>Status</th>${MILESTONES.map((m) => `<th>${m.label}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

export function handle() {
  return false;
}
