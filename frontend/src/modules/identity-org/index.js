/* identity-org module dispatcher — composes every screen's {render, handle,
   renderDrawer} into the shape app/shell.js consumes (mirrors the old
   `window.WFMWorkforce` object's public surface: NAV/FIRST/GROUP_OF/
   LEAF_SCREEN/render/handle/initState). Adding a new screen to this module
   means adding one entry to the TABS map below — nothing else in shell.js
   needs to change. */
import { NAV, FIRST, GROUP_OF, LEAF_SCREEN } from './nav.js';
import { initState } from './state.js';
import { handleCommon } from './shared/common-handlers.js';

import * as SelfIdentification from './self-identification/self-identification.js';
import * as Usernames from './usernames/usernames.js';
import * as UserAccessRights from './user-access-rights/user-access-rights.js';
import * as Employees from './employees/employees.js';
import * as Groups from './groups/groups.js';
import * as SchedulePreferences from './schedule-preferences/schedule-preferences.js';
import * as TimeOff from './time-off/time-off.js';
import * as Skills from './skills/skills.js';
import * as WorkRules from './work-rules/work-rules.js';
import * as Interactions from './interactions/interactions.js';
import * as StaffingProfile from './staffing-profile/staffing-profile.js';
import * as SystemConfigGeneral from './system-config/general.js';
import * as SystemConfigWfmDefaults from './system-config/wfm-defaults.js';
import * as SystemConfigSecurity from './system-config/security.js';
import * as SystemConfigEmail from './system-config/email.js';
import * as SystemConfigSso from './system-config/sso.js';
import * as SystemConfigDataSources from './system-config/data-sources.js';
import * as SystemConfigFeatureFlags from './system-config/feature-flags.js';
import * as SystemConfigRetention from './system-config/retention.js';
import * as SystemConfigNotifications from './system-config/notifications.js';
import * as SystemConfigAdvanced from './system-config/advanced.js';

export { NAV, FIRST, GROUP_OF, LEAF_SCREEN, initState };

const TABS = {
  selfid: SelfIdentification,
  usernames: Usernames,
  uar: UserAccessRights,
  profiles: Employees,
  groups: Groups,
  prefs: SchedulePreferences,
  timeoff: TimeOff,
  skills: Skills,
  rules: WorkRules,
  interactions: Interactions,
  staffing: StaffingProfile,
  'sc-general': SystemConfigGeneral,
  'sc-wfm': SystemConfigWfmDefaults,
  'sc-security': SystemConfigSecurity,
  'sc-email': SystemConfigEmail,
  'sc-sso': SystemConfigSso,
  'sc-datasources': SystemConfigDataSources,
  'sc-features': SystemConfigFeatureFlags,
  'sc-retention': SystemConfigRetention,
  'sc-notifications': SystemConfigNotifications,
  'sc-advanced': SystemConfigAdvanced,
};

/* Screens with a drawer (state.drawer !== null) tried in this order; the
   first one whose id matches wins — same as the original monolithic
   drawer(state) dispatcher, just distributed across modules. */
const DRAWER_MODULES = [
  Employees, Usernames, Interactions, Groups, Skills, WorkRules, StaffingProfile, TimeOff,
  SystemConfigSso, SystemConfigDataSources, SystemConfigRetention,
];

/* render(state) returns null for "roles" (and any tab this module doesn't
   own) so app/shell.js's own inner() falls through to its Roles Setup
   screens — same contract the old WF.render(state) had. */
export function render(state) {
  initState(state);
  const mod = TABS[state.tab];
  if (!mod) return null;
  const html = mod.render(state);
  const drawerHtml = DRAWER_MODULES.reduce((acc, m) => acc || (m.renderDrawer ? m.renderDrawer(state) : ""), "");
  return html + drawerHtml;
}

export function handle(state, act, id, value) {
  initState(state);
  if (act === "tab") {
    state.tab = id;
    state.group = GROUP_OF[id] || state.group;
    state.screen = LEAF_SCREEN[id] || id;
    state.drawer = null;
    return true;
  }
  if (act === "group-live") {
    state.group = id;
    state.tab = FIRST[id];
    state.screen = LEAF_SCREEN[state.tab];
    state.drawer = null;
    return true;
  }
  if (handleCommon(state, act, id, value)) return true;
  const mod = TABS[state.tab];
  return mod ? mod.handle(state, act, id, value) : false;
}
