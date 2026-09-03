/* Navigation registry for the Forecasting & Scheduling module. Mirrors
   identity-org/nav.js's shape ({NAV, FIRST, GROUP_OF, LEAF_SCREEN}) so
   app/shell.js can drive both modules through the same generic dispatch.

   Tab ids are prefixed per group (campaign-, wr-, fs-emp-, scn-, fc-, wa-,
   cal-) so they never collide with identity-org's own tab ids (profiles,
   rules, staffing, ...) since both live in the same shared state.tab/
   state.group namespace — see app/state.js.

   `live` marks whether a screen has been built yet. Screens land group by
   group across phases; the nav tree itself (labels, grouping, order) is
   fixed by the product spec and must not be renamed/reordered/merged as
   phases land. */

export const NAV = {
  Campaigns: [
    { id: 'campaign-settings', label: 'Settings', live: true },
    { id: 'campaign-queues', label: 'Queues', live: true },
  ],
  'Work Rules': [
    { id: 'wr-shifts', label: 'Shifts', live: true },
    { id: 'wr-shift-events', label: 'Shift Events', live: true },
    { id: 'wr-vto-events', label: 'VTO Events', live: true },
    { id: 'wr-ot-extensions', label: 'OT Extensions', live: true },
    { id: 'wr-work-patterns', label: 'Work Patterns', live: true },
    { id: 'wr-project-rules', label: 'Project Rules', live: true },
  ],
  Employees: [
    { id: 'fs-emp-profiles', label: 'Profiles', live: true },
    { id: 'fs-emp-skills', label: 'Skills', live: true },
    { id: 'fs-emp-work-rules', label: 'Work Rules', live: true },
    { id: 'fs-emp-time-banks', label: 'Time Banks', live: true },
  ],
  Scenarios: [
    { id: 'scn-staffing-profiles', label: 'Staffing Profiles', live: true },
  ],
  Forecasting: [
    { id: 'fc-tactical-forecast', label: 'Tactical Forecast', live: true },
    { id: 'fc-goals-requirements', label: 'Goals & Requirements', live: true },
    { id: 'fc-allocations', label: 'Allocations', live: true },
    { id: 'fc-backlog-age', label: 'Backlog Age', live: true },
    { id: 'fc-backlog-age-template', label: 'Backlog Age Template', live: true },
  ],
  'Workforce Analytics': [
    { id: 'wa-queue-analytics', label: 'Queue Analytics', live: true },
  ],
  Calendar: [
    { id: 'cal-calendar', label: 'Calendar', live: true },
    { id: 'cal-mass-schedule-editor', label: 'Mass Schedule Editor', live: true },
  ],
};

export const FIRST = Object.fromEntries(Object.entries(NAV).map(([g, tabs]) => [g, tabs[0].id]));

export const GROUP_OF = {};
Object.entries(NAV).forEach(([g, tabs]) => tabs.forEach((t) => (GROUP_OF[t.id] = g)));

/* Every tab in this module is its own leaf screen (no create/detail wizard
   sub-screens yet) — screen id === tab id, same convention identity-org
   uses for its non-wizard tabs. */
export const LEAF_SCREEN = Object.fromEntries(Object.keys(GROUP_OF).map((id) => [id, id]));
