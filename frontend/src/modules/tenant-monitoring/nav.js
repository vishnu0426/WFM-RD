/* Navigation registry for the Tenant Monitoring module (internal, platform_
   admin-only console — see app/platform-admin-shell.js, not a module inside
   app/shell.js's own MODULES). Same {NAV, FIRST, GROUP_OF, LEAF_SCREEN}
   shape as every other module (forecasting-scheduling/nav.js is the
   template). "All Tenants" (list/create/provision-admin) is first — the
   natural landing screen; Onboarding Funnel/Tenant Health are the
   read-only analytics views.

   Each top-level key here is its own entry in the left rail
   (app/platform-admin-shell.js's shell() renders Object.keys(NAV) as
   .nav-item buttons directly, one click, no drill-down) — NOT a tab nested
   under another group. System Configuration is its own top-level entry for
   exactly that reason: it needs to be a one-click destination, not a tab a
   platform_admin has to first open Platform to discover. */

export const NAV = {
  Tenants: [
    { id: 'tm-all-tenants', label: 'All Tenants', live: true },
    { id: 'tm-onboarding-funnel', label: 'Onboarding Funnel', live: true },
    { id: 'tm-health', label: 'Tenant Health', live: true },
  ],
  // Cross-cutting, not tied to any one tenant's onboarding — its own group.
  Platform: [{ id: 'tm-feature-flags', label: 'Feature Flags', live: true }],
  'System Configuration': [{ id: 'tm-system-config', label: 'System Configuration', live: true }],
  // Genuinely platform-wide (no tenant picker) — distinct from System
  // Configuration above, which is per-tenant.
  'Platform Settings': [{ id: 'tm-platform-settings', label: 'Platform Settings', live: true }],
  'Application Monitoring': [{ id: 'tm-app-monitoring', label: 'Application Monitoring', live: true }],
};

export const FIRST = Object.fromEntries(Object.entries(NAV).map(([g, tabs]) => [g, tabs[0].id]));

export const GROUP_OF = {};
Object.entries(NAV).forEach(([g, tabs]) => tabs.forEach((t) => (GROUP_OF[t.id] = g)));

export const LEAF_SCREEN = Object.fromEntries(Object.keys(GROUP_OF).map((id) => [id, id]));
