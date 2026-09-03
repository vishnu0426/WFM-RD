/* Navigation registry for the Tenant Admin Integration Management module.
   Same {NAV, FIRST, GROUP_OF, LEAF_SCREEN} contract as identity-org/nav.js
   and forecasting-scheduling/nav.js, so app/shell.js drives this module
   generically (see app/shell.js's MODULES registry). */

export const NAV = {
  'Integration Server': [{ id: 'is-servers', label: 'Integration Servers', live: true }],
  'Data Sources': [
    { id: 'ds-settings', label: 'Settings', live: true },
    { id: 'ds-groups', label: 'Data Source Groups', live: true },
    { id: 'ds-agents', label: 'Agents', live: true },
    { id: 'ds-reason-codes', label: 'Reason Codes', live: true },
    { id: 'ds-import-status', label: 'Import Status', live: true },
    { id: 'ds-historical', label: 'Historical Data', live: true },
    { id: 'ds-health', label: 'Integration Health', live: true },
  ],
  'Real-Time Integration': [
    { id: 'rt-capabilities', label: 'Event Capabilities', live: true },
    { id: 'rt-ingestion', label: 'Event Ingestion Status', live: true },
    { id: 'rt-diagnostics', label: 'Event Diagnostics', live: true },
  ],
  'Scorecards Sources': [
    { id: 'sco-measures', label: 'Source Measures', live: true },
    { id: 'sco-systems', label: 'Source Systems', live: true },
    { id: 'sco-codes', label: 'Source Codes', live: true },
    { id: 'sco-mappings', label: 'Source Mappings', live: true },
    { id: 'sco-fs-queue-mappings', label: 'F&S Queue Mappings', live: true },
    { id: 'sco-dimension-types', label: 'Dimension Types', live: true },
    { id: 'sco-dimension-members', label: 'Dimension Members', live: true },
  ],
};

export const FIRST = {
  'Integration Server': 'is-servers',
  'Data Sources': 'ds-settings',
  'Real-Time Integration': 'rt-capabilities',
  'Scorecards Sources': 'sco-systems',
};

export const GROUP_OF = {};
Object.entries(NAV).forEach(([g, tabs]) => tabs.forEach((t) => (GROUP_OF[t.id] = g)));

export const LEAF_SCREEN = {};
Object.keys(GROUP_OF).forEach((id) => (LEAF_SCREEN[id] = id));
