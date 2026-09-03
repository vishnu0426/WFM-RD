/* Navigation registry for the Tenant Monitoring module (internal, platform_
   admin-only console — see app/platform-admin-shell.js, not a module inside
   app/shell.js's own MODULES). Same {NAV, FIRST, GROUP_OF, LEAF_SCREEN}
   shape as every other module (forecasting-scheduling/nav.js is the
   template). "All Tenants" (list/create/provision-admin) is first — the
   natural landing screen; Onboarding Funnel/Tenant Health are the
   read-only analytics views. */

export const NAV = {
  Tenants: [
    { id: 'tm-all-tenants', label: 'All Tenants', live: true },
    { id: 'tm-onboarding-funnel', label: 'Onboarding Funnel', live: true },
    { id: 'tm-health', label: 'Tenant Health', live: true },
  ],
  // Cross-cutting, not tied to any one tenant's onboarding — its own group.
  Platform: [{ id: 'tm-feature-flags', label: 'Feature Flags', live: true }],
};

export const FIRST = Object.fromEntries(Object.entries(NAV).map(([g, tabs]) => [g, tabs[0].id]));

export const GROUP_OF = {};
Object.entries(NAV).forEach(([g, tabs]) => tabs.forEach((t) => (GROUP_OF[t.id] = g)));

export const LEAF_SCREEN = Object.fromEntries(Object.keys(GROUP_OF).map((id) => [id, id]));
