/* Tenant Admin Integration Management module dispatcher — same {NAV,
   FIRST, GROUP_OF, LEAF_SCREEN, render, handle} contract as
   forecasting-scheduling/index.js, so app/shell.js drives this module
   generically. Replaces the previous stub (index.js used to render "Not
   yet built in this console"). */
import { NAV, FIRST, GROUP_OF, LEAF_SCREEN } from './nav.js';
import { handleCommon } from '../identity-org/shared/common-handlers.js';

import * as IntegrationServer from './integration-server/integration-server.js';
import * as DataSources from './data-sources/data-sources.js';
import * as DataSourceGroups from './data-sources/data-source-groups.js';
import * as Agents from './data-sources/agents.js';
import * as ReasonCodes from './data-sources/reason-codes.js';
import * as ImportStatus from './data-sources/import-status.js';
import * as HistoricalData from './data-sources/historical-data.js';
import * as IntegrationHealth from './data-sources/integration-health.js';
import * as RealTime from './real-time/real-time.js';
import * as Scorecards from './scorecards/scorecards.js';

export { NAV, FIRST, GROUP_OF, LEAF_SCREEN };

const TABS = {
  'is-servers': IntegrationServer,
  'ds-settings': DataSources,
  'ds-groups': DataSourceGroups,
  'ds-agents': Agents,
  'ds-reason-codes': ReasonCodes,
  'ds-import-status': ImportStatus,
  'ds-historical': HistoricalData,
  'ds-health': IntegrationHealth,
  'rt-capabilities': RealTime,
  'rt-ingestion': RealTime,
  'rt-diagnostics': RealTime,
  'sco-measures': Scorecards,
  'sco-systems': Scorecards,
  'sco-codes': Scorecards,
  'sco-mappings': Scorecards,
  'sco-fs-queue-mappings': Scorecards,
  'sco-dimension-types': Scorecards,
  'sco-dimension-members': Scorecards,
};

/* Screens with a drawer (state.drawer !== null), tried in this order —
   same convention as identity-org/index.js's DRAWER_MODULES. */
const DRAWER_MODULES = [IntegrationServer, DataSources, DataSourceGroups, Agents, ReasonCodes, HistoricalData, Scorecards];

export function render(state) {
  const mod = TABS[state.tab];
  if (!mod) return null;
  const html = mod.render(state);
  const drawerHtml = DRAWER_MODULES.reduce((acc, m) => acc || (m.renderDrawer ? m.renderDrawer(state) : ''), '');
  return html + drawerHtml;
}

export function handle(state, act, id, value) {
  if (act === 'tab') {
    if (!GROUP_OF[id]) return false;
    state.tab = id;
    state.group = GROUP_OF[id];
    state.screen = LEAF_SCREEN[id] || id;
    state.drawer = null;
    return true;
  }
  if (act === 'group-live') {
    if (!NAV[id]) return false;
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
