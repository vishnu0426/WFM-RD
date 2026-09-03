/* Forecasting & Scheduling module dispatcher — same contract as
   identity-org/index.js ({NAV, FIRST, GROUP_OF, LEAF_SCREEN, render, handle})
   so app/shell.js can drive either module generically. Screens are added to
   TABS here one at a time as each phase lands; every tab not yet in TABS
   renders a placeholder and is marked `live: false` in nav.js (shown
   disabled in the nav, per the existing dead-tab convention). */
import { NAV, FIRST, GROUP_OF, LEAF_SCREEN } from './nav.js';
import { handleCommon } from '../identity-org/shared/common-handlers.js';

/* Scenarios > Staffing Profiles reuses identity-org's Staffing Profile
   screen verbatim (same component, same scheduling-service API, same
   state.wf.* cache) rather than forking a second copy — it's the same
   staffing-profile entity and CRUD flow, just also reachable from this
   module's nav. See identity-org/staffing-profile/staffing-profile.js. */
import * as StaffingProfile from '../identity-org/staffing-profile/staffing-profile.js';
import * as Campaigns from './campaigns/campaigns.js';
import * as ShiftEventRequests from './work-rules/shift-event-requests.js';
import * as ProjectRules from './work-rules/project-rules.js';
/* Employees > Profiles/Skills/Work Rules reuse identity-org's own Employees
   screens verbatim — same Employee entity, same GraphQL API, same state.wf.*
   cache — rather than a second Employee model (RosterEmployee etc.), which
   the product spec explicitly forbids. */
import * as Employees from '../identity-org/employees/employees.js';
import * as Skills from '../identity-org/skills/skills.js';
import * as WorkRules from '../identity-org/work-rules/work-rules.js';
import * as TimeBanks from './employees/time-banks.js';
import * as TacticalForecast from './forecasting/tactical-forecast.js';
import * as GoalsRequirements from './forecasting/goals-requirements.js';
import * as Allocations from './forecasting/allocations.js';
import * as BacklogAge from './forecasting/backlog-age.js';
import * as BacklogAgeTemplate from './forecasting/backlog-age-template.js';
import * as QueueAnalytics from './workforce-analytics/queue-analytics.js';
import * as Calendar from './calendar/calendar.js';
import * as MassScheduleEditor from './calendar/mass-schedule-editor.js';

export { NAV, FIRST, GROUP_OF, LEAF_SCREEN };

const TABS = {
  'scn-staffing-profiles': StaffingProfile,
  'campaign-settings': Campaigns,
  'campaign-queues': Campaigns,
  /* Shifts/Work Patterns are the same shift-template/work-pattern entities
     already exposed by identity-org's Staffing Profile screen (its Shift
     Templates / Work Patterns sub-tabs) — reused verbatim rather than
     forked, same as Scenarios > Staffing Profiles above. Which sub-tab
     opens is set by STAFFING_SUBTAB_BY_TAB below. */
  'wr-shifts': StaffingProfile,
  'wr-work-patterns': StaffingProfile,
  'wr-shift-events': ShiftEventRequests,
  'wr-vto-events': ShiftEventRequests,
  'wr-ot-extensions': ShiftEventRequests,
  'wr-project-rules': ProjectRules,
  'fs-emp-profiles': Employees,
  'fs-emp-skills': Skills,
  'fs-emp-work-rules': WorkRules,
  'fs-emp-time-banks': TimeBanks,
  'fc-tactical-forecast': TacticalForecast,
  'fc-goals-requirements': GoalsRequirements,
  'fc-allocations': Allocations,
  'fc-backlog-age': BacklogAge,
  'fc-backlog-age-template': BacklogAgeTemplate,
  'wa-queue-analytics': QueueAnalytics,
  'cal-calendar': Calendar,
  'cal-mass-schedule-editor': MassScheduleEditor,
};

const STAFFING_SUBTAB_BY_TAB = {
  'scn-staffing-profiles': 'profiles',
  'wr-shifts': 'templates',
  'wr-work-patterns': 'patterns',
};

/* Screens with a drawer (state.drawer !== null), tried in this order —
   same convention as identity-org/index.js's DRAWER_MODULES. */
const DRAWER_MODULES = [StaffingProfile, Campaigns, ShiftEventRequests, ProjectRules, Employees, Skills, WorkRules, TimeBanks, BacklogAge, BacklogAgeTemplate];

function labelFor(tab) {
  const group = GROUP_OF[tab];
  return (NAV[group] || []).find((t) => t.id === tab)?.label || tab;
}

function placeholder(state) {
  const label = labelFor(state.tab);
  return `
    <div class="page-head"><div><h1>${label}</h1><p>${state.group} — Forecasting &amp; Scheduling</p></div></div>
    <div class="panel"><div class="empty">
      <h2>Not built yet</h2>
      <p>This screen is part of the Forecasting &amp; Scheduling navigation and lands in a later phase.</p>
    </div></div>`;
}

export function render(state) {
  const mod = TABS[state.tab];
  if (mod) {
    const html = mod.render(state);
    const drawerHtml = DRAWER_MODULES.reduce((acc, m) => acc || (m.renderDrawer ? m.renderDrawer(state) : ''), '');
    return html + drawerHtml;
  }
  if (GROUP_OF[state.tab]) return placeholder(state);
  return null;
}

export function handle(state, act, id, value) {
  if (act === 'tab') {
    if (!GROUP_OF[id]) return false;
    state.tab = id;
    state.group = GROUP_OF[id];
    state.screen = LEAF_SCREEN[id] || id;
    state.drawer = null;
    if (STAFFING_SUBTAB_BY_TAB[id]) state.staffingSubTab = STAFFING_SUBTAB_BY_TAB[id];
    return true;
  }
  if (act === 'group-live') {
    if (!NAV[id]) return false;
    state.group = id;
    state.tab = FIRST[id];
    state.screen = LEAF_SCREEN[state.tab];
    state.drawer = null;
    if (STAFFING_SUBTAB_BY_TAB[state.tab]) state.staffingSubTab = STAFFING_SUBTAB_BY_TAB[state.tab];
    return true;
  }
  if (handleCommon(state, act, id, value)) return true;
  const mod = TABS[state.tab];
  return mod ? mod.handle(state, act, id, value) : false;
}
