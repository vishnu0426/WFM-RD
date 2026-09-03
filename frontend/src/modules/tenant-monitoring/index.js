/* Tenant Monitoring module dispatcher — same contract as every other
   module ({NAV, FIRST, GROUP_OF, LEAF_SCREEN, render, handle}) so
   app/platform-admin-shell.js can drive it generically. Internal,
   platform_admin-only console (see app/main.js's routing and
   platform-admin-shell.js's own doc comment) — this module assumes it is
   never reached by any other caller; the guard lives outside it, not here. */
import { NAV, FIRST, GROUP_OF, LEAF_SCREEN } from './nav.js';
import * as AllTenants from './all-tenants/all-tenants.js';
import * as OnboardingFunnel from './onboarding-funnel/onboarding-funnel.js';
import * as TenantHealth from './tenant-health/tenant-health.js';
import * as FeatureFlags from './feature-flags/feature-flags.js';

export { NAV, FIRST, GROUP_OF, LEAF_SCREEN };

const TABS = {
  'tm-all-tenants': AllTenants,
  'tm-onboarding-funnel': OnboardingFunnel,
  'tm-health': TenantHealth,
  'tm-feature-flags': FeatureFlags,
};

export function render(state) {
  const mod = TABS[state.tab];
  const html = mod ? mod.render(state) : null;
  return html == null ? html : html + (AllTenants.renderDrawer(state) || '');
}

export function handle(state, act, id, value) {
  if (act === 'tab') {
    if (!GROUP_OF[id]) return false;
    state.tab = id;
    state.group = GROUP_OF[id];
    state.screen = LEAF_SCREEN[id] || id;
    return true;
  }
  if (act === 'group-live') {
    if (!NAV[id]) return false;
    state.group = id;
    state.tab = FIRST[id];
    state.screen = LEAF_SCREEN[state.tab];
    return true;
  }
  // AllTenants' own drawer actions (open-create-tenant, close-drawer, ...)
  // must work regardless of which tab is active, same reasoning
  // forecasting-scheduling/index.js's DRAWER_MODULES compositing documents.
  if (AllTenants.handle(state, act, id, value)) return true;
  const mod = TABS[state.tab];
  return mod ? mod.handle(state, act, id, value) : false;
}
