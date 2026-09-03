/* Scorecards Sources — Source Measures/Systems/Codes/Mappings, Dimension
   Types/Members, F&S Queue Mappings. Real backend: analytics-reporting-
   service's Scorecard* GraphQL (WP6) for the first six; F&S Queue
   Mappings reuses forecasting-service's real Campaign/CampaignQueue REST
   API directly (plan decision: no new entity — Campaign/CcQueue already
   exist and already do this). One file for all seven tabs, mirroring how
   ScorecardSourcesService/ScorecardSourceResolver consolidate the same
   six entities on the backend. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../../identity-org/shared/ui.js';

/* ---------- Source Systems ---------- */

const SYSTEMS_QUERY = `query { scorecardSourceSystems { id name provider connectorId status updatedAt } }`;
const UPSERT_SYSTEM = `mutation($id: ID, $name: String!, $provider: String!, $connectorId: ID) { upsertScorecardSourceSystem(id: $id, name: $name, provider: $provider, connectorId: $connectorId) { id } }`;
const DELETE_SYSTEM = `mutation($id: ID!) { deleteScorecardSourceSystem(id: $id) }`;

function loadSystems(state) {
  state.wf.scoSystems = { loading: true };
  Api.analyticsGql(SYSTEMS_QUERY, {})
    .then((data) => { state.wf.scoSystems = { rows: data.scorecardSourceSystems }; doRerender(); })
    .catch((err) => { state.wf.scoSystems = { error: errMsg(err) }; doRerender(); });
}

function systemsList(state) { return (state.wf.scoSystems && state.wf.scoSystems.rows) || []; }

function renderSystems(state) {
  if (!state.wf.scoSystems) loadSystems(state);
  const list = state.wf.scoSystems;
  const body = !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No source systems yet.', 'Register an external QM/scorecard system.', `<button class="btn btn-primary" data-wf="sco-sys-open">+ New Source System</button>`)
    : `<table class="data"><thead><tr><th>Name</th><th>Provider</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.rows.map((s) => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(s.provider)}</td><td>${esc(s.status)}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-sys-edit" data-id="${s.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-sys-delete" data-id="${s.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Source Systems', 'External scorecard/QM systems registered for this tenant.', `<button class="btn btn-primary" data-wf="sco-sys-open">+ New Source System</button>`)}
    ${sec('Source Systems', body, `<span class="meta">GraphQL: scorecardSourceSystems</span>`)}`;
}

/* ---------- Source Measures ---------- */

const MEASURES_QUERY = `query($sourceSystemId: ID!) { scorecardSourceMeasures(sourceSystemId: $sourceSystemId) { id sourceSystemId code name description unit updatedAt } }`;
const UPSERT_MEASURE = `mutation($id: ID, $sourceSystemId: ID!, $code: String!, $name: String!, $description: String, $unit: String) { upsertScorecardSourceMeasure(id: $id, sourceSystemId: $sourceSystemId, code: $code, name: $name, description: $description, unit: $unit) { id } }`;
const DELETE_MEASURE = `mutation($id: ID!) { deleteScorecardSourceMeasure(id: $id) }`;

function loadMeasures(state, sourceSystemId) {
  state.wf.scoMeasures = { loading: true };
  Api.analyticsGql(MEASURES_QUERY, { sourceSystemId })
    .then((data) => { state.wf.scoMeasures = { rows: data.scorecardSourceMeasures }; doRerender(); })
    .catch((err) => { state.wf.scoMeasures = { error: errMsg(err) }; doRerender(); });
}

function renderMeasures(state) {
  if (!state.wf.scoSystems) loadSystems(state);
  const systems = systemsList(state);
  if (!state.scoMeasuresSystemId && systems.length) state.scoMeasuresSystemId = systems[0].id;
  if (state.scoMeasuresSystemId && !state.wf.scoMeasures) loadMeasures(state, state.scoMeasuresSystemId);
  const list = state.wf.scoMeasures;
  const body = !state.scoMeasuresSystemId ? empty('No source systems yet.', 'Create one under Source Systems first.')
    : !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No measures yet.', '', `<button class="btn btn-primary" data-wf="sco-mea-open">+ New Measure</button>`)
    : `<table class="data"><thead><tr><th>Code</th><th>Name</th><th>Unit</th><th>Description</th><th></th></tr></thead><tbody>
        ${list.rows.map((m) => `<tr><td class="mono">${esc(m.code)}</td><td>${esc(m.name)}</td><td>${esc(m.unit || '—')}</td><td class="muted">${esc(m.description || '—')}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-mea-edit" data-id="${m.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-mea-delete" data-id="${m.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Source Measures', 'Metrics an external scorecard source exposes.', `<button class="btn btn-primary" data-wf="sco-mea-open" ${state.scoMeasuresSystemId ? '' : 'disabled'}>+ New Measure</button>`)}
    ${sec('Measures', `<div class="toolbar">${systemSelect(systems, state.scoMeasuresSystemId, 'sco-mea-select-system')}<button class="btn" data-wf="sco-mea-refresh">Refresh</button></div>${body}`, `<span class="meta">GraphQL: scorecardSourceMeasures</span>`)}`;
}

/* ---------- Source Codes ---------- */

const CODES_QUERY = `query($sourceSystemId: ID!) { scorecardSourceCodes(sourceSystemId: $sourceSystemId) { id sourceSystemId code description updatedAt } }`;
const UPSERT_CODE = `mutation($id: ID, $sourceSystemId: ID!, $code: String!, $description: String) { upsertScorecardSourceCode(id: $id, sourceSystemId: $sourceSystemId, code: $code, description: $description) { id } }`;
const DELETE_CODE = `mutation($id: ID!) { deleteScorecardSourceCode(id: $id) }`;

function loadCodes(state, sourceSystemId) {
  state.wf.scoCodes = { loading: true };
  Api.analyticsGql(CODES_QUERY, { sourceSystemId })
    .then((data) => { state.wf.scoCodes = { rows: data.scorecardSourceCodes }; doRerender(); })
    .catch((err) => { state.wf.scoCodes = { error: errMsg(err) }; doRerender(); });
}

function renderCodes(state) {
  if (!state.wf.scoSystems) loadSystems(state);
  const systems = systemsList(state);
  if (!state.scoCodesSystemId && systems.length) state.scoCodesSystemId = systems[0].id;
  if (state.scoCodesSystemId && !state.wf.scoCodes) loadCodes(state, state.scoCodesSystemId);
  const list = state.wf.scoCodes;
  const body = !state.scoCodesSystemId ? empty('No source systems yet.', 'Create one under Source Systems first.')
    : !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No source codes yet.', '', `<button class="btn btn-primary" data-wf="sco-cod-open">+ New Code</button>`)
    : `<table class="data"><thead><tr><th>Code</th><th>Description</th><th></th></tr></thead><tbody>
        ${list.rows.map((c) => `<tr><td class="mono">${esc(c.code)}</td><td class="muted">${esc(c.description || '—')}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-cod-edit" data-id="${c.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-cod-delete" data-id="${c.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Source Codes', 'Raw code catalog an external scorecard source emits.', `<button class="btn btn-primary" data-wf="sco-cod-open" ${state.scoCodesSystemId ? '' : 'disabled'}>+ New Code</button>`)}
    ${sec('Source Codes', `<div class="toolbar">${systemSelect(systems, state.scoCodesSystemId, 'sco-cod-select-system')}<button class="btn" data-wf="sco-cod-refresh">Refresh</button></div>${body}`, `<span class="meta">GraphQL: scorecardSourceCodes</span>`)}`;
}

/* ---------- Source Mappings ---------- */

const MAPPINGS_QUERY = `query($sourceMeasureId: ID!) { scorecardSourceMappings(sourceMeasureId: $sourceMeasureId) { id sourceMeasureId targetMetric description updatedAt } }`;
const UPSERT_MAPPING = `mutation($id: ID, $sourceMeasureId: ID!, $targetMetric: String!, $description: String) { upsertScorecardSourceMapping(id: $id, sourceMeasureId: $sourceMeasureId, targetMetric: $targetMetric, description: $description) { id } }`;
const DELETE_MAPPING = `mutation($id: ID!) { deleteScorecardSourceMapping(id: $id) }`;

function loadMappings(state, sourceMeasureId) {
  state.wf.scoMappings = { loading: true };
  Api.analyticsGql(MAPPINGS_QUERY, { sourceMeasureId })
    .then((data) => { state.wf.scoMappings = { rows: data.scorecardSourceMappings }; doRerender(); })
    .catch((err) => { state.wf.scoMappings = { error: errMsg(err) }; doRerender(); });
}

function renderMappings(state) {
  if (!state.wf.scoSystems) loadSystems(state);
  const systems = systemsList(state);
  if (!state.scoMapSystemId && systems.length) state.scoMapSystemId = systems[0].id;
  if (state.scoMapSystemId && !state.wf.scoMapMeasures) {
    state.wf.scoMapMeasures = { loading: true };
    Api.analyticsGql(MEASURES_QUERY, { sourceSystemId: state.scoMapSystemId })
      .then((data) => { state.wf.scoMapMeasures = { rows: data.scorecardSourceMeasures }; doRerender(); })
      .catch((err) => { state.wf.scoMapMeasures = { error: errMsg(err) }; doRerender(); });
  }
  const measures = (state.wf.scoMapMeasures && state.wf.scoMapMeasures.rows) || [];
  if (!state.scoMapMeasureId && measures.length) state.scoMapMeasureId = measures[0].id;
  if (state.scoMapMeasureId && !state.wf.scoMappings) loadMappings(state, state.scoMapMeasureId);
  const list = state.wf.scoMappings;
  const body = !state.scoMapMeasureId ? empty('No measures yet.', 'Create one under Source Measures first.')
    : !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No mappings yet.', 'Map this measure onto a WFM-facing metric label.', `<button class="btn btn-primary" data-wf="sco-map-open">+ New Mapping</button>`)
    : `<table class="data"><thead><tr><th>Target Metric</th><th>Description</th><th></th></tr></thead><tbody>
        ${list.rows.map((m) => `<tr><td>${esc(m.targetMetric)}</td><td class="muted">${esc(m.description || '—')}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-map-edit" data-id="${m.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-map-delete" data-id="${m.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Source Mappings', 'Maps a Source Measure onto a WFM-facing metric label (tenant-authored — no canonical KPI catalog exists to map onto).', `<button class="btn btn-primary" data-wf="sco-map-open" ${state.scoMapMeasureId ? '' : 'disabled'}>+ New Mapping</button>`)}
    ${sec('Source Mappings', `<div class="toolbar">${systemSelect(systems, state.scoMapSystemId, 'sco-map-select-system')}${measureSelect(measures, state.scoMapMeasureId)}<button class="btn" data-wf="sco-map-refresh">Refresh</button></div>${body}`, `<span class="meta">GraphQL: scorecardSourceMappings</span>`)}`;
}

/* ---------- Dimension Types ---------- */

const DIM_TYPES_QUERY = `query { scorecardDimensionTypes { id name description updatedAt } }`;
const UPSERT_DIM_TYPE = `mutation($id: ID, $name: String!, $description: String) { upsertScorecardDimensionType(id: $id, name: $name, description: $description) { id } }`;
const DELETE_DIM_TYPE = `mutation($id: ID!) { deleteScorecardDimensionType(id: $id) }`;

function loadDimTypes(state) {
  state.wf.scoDimTypes = { loading: true };
  Api.analyticsGql(DIM_TYPES_QUERY, {})
    .then((data) => { state.wf.scoDimTypes = { rows: data.scorecardDimensionTypes }; doRerender(); })
    .catch((err) => { state.wf.scoDimTypes = { error: errMsg(err) }; doRerender(); });
}

function dimTypesList(state) { return (state.wf.scoDimTypes && state.wf.scoDimTypes.rows) || []; }

function renderDimTypes(state) {
  if (!state.wf.scoDimTypes) loadDimTypes(state);
  const list = state.wf.scoDimTypes;
  const body = !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No dimension types yet.', 'e.g. Team, Site, Skill.', `<button class="btn btn-primary" data-wf="sco-dt-open">+ New Dimension Type</button>`)
    : `<table class="data"><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>
        ${list.rows.map((d) => `<tr><td>${esc(d.name)}</td><td class="muted">${esc(d.description || '—')}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-dt-edit" data-id="${d.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-dt-delete" data-id="${d.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Dimension Types', 'Tenant-defined scorecard dimension categories.', `<button class="btn btn-primary" data-wf="sco-dt-open">+ New Dimension Type</button>`)}
    ${sec('Dimension Types', body, `<span class="meta">GraphQL: scorecardDimensionTypes</span>`)}`;
}

/* ---------- Dimension Members ---------- */

const DIM_MEMBERS_QUERY = `query($dimensionTypeId: ID!) { scorecardDimensionMembers(dimensionTypeId: $dimensionTypeId) { id dimensionTypeId code name updatedAt } }`;
const UPSERT_DIM_MEMBER = `mutation($id: ID, $dimensionTypeId: ID!, $code: String!, $name: String!) { upsertScorecardDimensionMember(id: $id, dimensionTypeId: $dimensionTypeId, code: $code, name: $name) { id } }`;
const DELETE_DIM_MEMBER = `mutation($id: ID!) { deleteScorecardDimensionMember(id: $id) }`;

function loadDimMembers(state, dimensionTypeId) {
  state.wf.scoDimMembers = { loading: true };
  Api.analyticsGql(DIM_MEMBERS_QUERY, { dimensionTypeId })
    .then((data) => { state.wf.scoDimMembers = { rows: data.scorecardDimensionMembers }; doRerender(); })
    .catch((err) => { state.wf.scoDimMembers = { error: errMsg(err) }; doRerender(); });
}

function renderDimMembers(state) {
  if (!state.wf.scoDimTypes) loadDimTypes(state);
  const types = dimTypesList(state);
  if (!state.scoDimMembersTypeId && types.length) state.scoDimMembersTypeId = types[0].id;
  if (state.scoDimMembersTypeId && !state.wf.scoDimMembers) loadDimMembers(state, state.scoDimMembersTypeId);
  const list = state.wf.scoDimMembers;
  const body = !state.scoDimMembersTypeId ? empty('No dimension types yet.', 'Create one under Dimension Types first.')
    : !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No members yet.', '', `<button class="btn btn-primary" data-wf="sco-dm-open">+ New Member</button>`)
    : `<table class="data"><thead><tr><th>Code</th><th>Name</th><th></th></tr></thead><tbody>
        ${list.rows.map((m) => `<tr><td class="mono">${esc(m.code)}</td><td>${esc(m.name)}</td>
          <td class="row-actions"><button class="btn btn-sm" data-wf="sco-dm-edit" data-id="${m.id}">Edit</button><button class="btn btn-sm btn-danger" data-wf="sco-dm-delete" data-id="${m.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>`;
  return `${pageHead('Dimension Members', 'Members/values under a dimension type.', `<button class="btn btn-primary" data-wf="sco-dm-open" ${state.scoDimMembersTypeId ? '' : 'disabled'}>+ New Member</button>`)}
    ${sec('Dimension Members', `<div class="toolbar">${dimTypeSelect(types, state.scoDimMembersTypeId)}<button class="btn" data-wf="sco-dm-refresh">Refresh</button></div>${body}`, `<span class="meta">GraphQL: scorecardDimensionMembers</span>`)}`;
}

/* ---------- F&S Queue Mappings (reuses forecasting-service Campaign/CampaignQueue) ---------- */

function loadCampaigns(state) {
  state.wf.scoCampaigns = { loading: true };
  Api.forecastingApi('/v1/forecasting/campaigns')
    .then((rows) => { state.wf.scoCampaigns = { rows }; doRerender(); })
    .catch((err) => { state.wf.scoCampaigns = { error: errMsg(err) }; doRerender(); });
}

function loadCampaignQueues(state, campaignId) {
  state.wf.scoCampaignQueues = { loading: true };
  Api.forecastingApi(`/v1/forecasting/campaigns/${campaignId}/queues`)
    .then((rows) => { state.wf.scoCampaignQueues = { rows }; doRerender(); })
    .catch((err) => { state.wf.scoCampaignQueues = { error: errMsg(err) }; doRerender(); });
}

function loadAllCcQueues(state) {
  state.wf.scoCcQueues = { loading: true };
  Api.forecastingApi('/v1/forecasting/cc-queues')
    .then((rows) => { state.wf.scoCcQueues = { rows }; doRerender(); })
    .catch((err) => { state.wf.scoCcQueues = { error: errMsg(err) }; doRerender(); });
}

function renderFsQueueMappings(state) {
  if (!state.wf.scoCampaigns) loadCampaigns(state);
  const campaigns = (state.wf.scoCampaigns && state.wf.scoCampaigns.rows) || [];
  if (!state.scoFsCampaignId && campaigns.length) state.scoFsCampaignId = campaigns[0].id;
  if (state.scoFsCampaignId && !state.wf.scoCampaignQueues) loadCampaignQueues(state, state.scoFsCampaignId);
  if (!state.wf.scoCcQueues) loadAllCcQueues(state);
  const ccQueues = (state.wf.scoCcQueues && state.wf.scoCcQueues.rows) || [];
  const list = state.wf.scoCampaignQueues;
  const memberOrgUnits = new Set((list && list.rows || []).map((q) => q.orgUnitId));
  const available = ccQueues.filter((q) => !memberOrgUnits.has(q.orgUnitId));

  const body = !state.scoFsCampaignId ? empty('No campaigns yet.', 'Create one under Forecasting & Scheduling → Campaigns first.')
    : !list || list.loading ? skel()
    : list.error ? errP(list.error)
    : list.rows.length === 0 ? empty('No queues mapped to this campaign yet.', '')
    : `<table class="data"><thead><tr><th>Org Unit</th><th>Matching Queues</th><th></th></tr></thead><tbody>
        ${list.rows.map((q) => `<tr><td class="mono">${esc(q.orgUnitId)}</td><td>${esc(ccQueues.filter((c) => c.orgUnitId === q.orgUnitId).map((c) => c.name).join(', ') || '—')}</td>
          <td><button class="btn btn-sm btn-danger" data-wf="sco-fs-remove" data-id="${q.orgUnitId}">Remove</button></td></tr>`).join('')}
      </tbody></table>`;

  return `${pageHead('F&S Queue Mappings', 'Assigns Forecasting & Scheduling queues (CcQueue) to a Campaign — reuses the real forecasting-service Campaign/CampaignQueue API directly, no separate entity.', '')}
    ${sec('Campaign Queue Assignment', `
      <div class="toolbar">
        ${campaigns.length ? `<select data-wf="sco-fs-select-campaign">${campaigns.map((c) => `<option value="${c.id}" ${state.scoFsCampaignId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
        <select data-wf="sco-fs-add-select"><option value="">Select a queue to add…</option>${available.map((q) => `<option value="${q.orgUnitId}">${esc(q.name)} (${esc(q.externalQueueId)})</option>`).join('')}</select>
        <button class="btn" data-wf="sco-fs-add" ${state.scoFsCampaignId ? '' : 'disabled'}>Add</button>
        <button class="btn" data-wf="sco-fs-refresh">Refresh</button>
      </div>
      ${body}
    `, `<span class="meta">REST: /v1/forecasting/campaigns/:id/queues</span>`)}`;
}

/* ---------- shared bits ---------- */

function skel() { return `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`; }
function errP(msg) { return `<p class="muted">${esc(msg)}</p>`; }
function systemSelect(systems, selected, act) {
  return `<select data-wf="${act}">${systems.map((s) => `<option value="${s.id}" ${selected === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}
function measureSelect(measures, selected) {
  return `<select data-wf="sco-map-select-measure">${measures.map((m) => `<option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
}
function dimTypeSelect(types, selected) {
  return `<select data-wf="sco-dm-select-type">${types.map((t) => `<option value="${t.id}" ${selected === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
}

export function render(state) {
  switch (state.tab) {
    case 'sco-measures': return renderMeasures(state);
    case 'sco-systems': return renderSystems(state);
    case 'sco-codes': return renderCodes(state);
    case 'sco-mappings': return renderMappings(state);
    case 'sco-fs-queue-mappings': return renderFsQueueMappings(state);
    case 'sco-dimension-types': return renderDimTypes(state);
    case 'sco-dimension-members': return renderDimMembers(state);
    default: return renderSystems(state);
  }
}

export function renderDrawer(state) {
  if (state.drawer === 'sco-sys-edit') {
    const d = state.scoSysDraft;
    return drawerShell(state.scoSysEditId ? 'Edit Source System' : 'New Source System', 'GraphQL: upsertScorecardSourceSystem', `
      <div class="field"><label>Name</label><input data-wf="sco-sys-field" data-id="name" value="${esc(d.name)}" /></div>
      <div class="field" style="margin-top:10px"><label>Provider</label><input data-wf="sco-sys-field" data-id="provider" value="${esc(d.provider)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-sys-save">Save</button>`);
  }
  if (state.drawer === 'sco-mea-edit') {
    const d = state.scoMeaDraft;
    return drawerShell(state.scoMeaEditId ? 'Edit Measure' : 'New Measure', 'GraphQL: upsertScorecardSourceMeasure', `
      <div class="field"><label>Code</label><input data-wf="sco-mea-field" data-id="code" value="${esc(d.code)}" /></div>
      <div class="field" style="margin-top:10px"><label>Name</label><input data-wf="sco-mea-field" data-id="name" value="${esc(d.name)}" /></div>
      <div class="field" style="margin-top:10px"><label>Unit</label><input data-wf="sco-mea-field" data-id="unit" value="${esc(d.unit)}" /></div>
      <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="sco-mea-field" data-id="description" value="${esc(d.description)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-mea-save">Save</button>`);
  }
  if (state.drawer === 'sco-cod-edit') {
    const d = state.scoCodDraft;
    return drawerShell(state.scoCodEditId ? 'Edit Code' : 'New Code', 'GraphQL: upsertScorecardSourceCode', `
      <div class="field"><label>Code</label><input data-wf="sco-cod-field" data-id="code" value="${esc(d.code)}" /></div>
      <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="sco-cod-field" data-id="description" value="${esc(d.description)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-cod-save">Save</button>`);
  }
  if (state.drawer === 'sco-map-edit') {
    const d = state.scoMapDraft;
    return drawerShell(state.scoMapEditId ? 'Edit Mapping' : 'New Mapping', 'GraphQL: upsertScorecardSourceMapping', `
      <div class="field"><label>Target Metric</label><input data-wf="sco-map-field" data-id="targetMetric" value="${esc(d.targetMetric)}" /></div>
      <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="sco-map-field" data-id="description" value="${esc(d.description)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-map-save">Save</button>`);
  }
  if (state.drawer === 'sco-dt-edit') {
    const d = state.scoDtDraft;
    return drawerShell(state.scoDtEditId ? 'Edit Dimension Type' : 'New Dimension Type', 'GraphQL: upsertScorecardDimensionType', `
      <div class="field"><label>Name</label><input data-wf="sco-dt-field" data-id="name" value="${esc(d.name)}" /></div>
      <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="sco-dt-field" data-id="description" value="${esc(d.description)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-dt-save">Save</button>`);
  }
  if (state.drawer === 'sco-dm-edit') {
    const d = state.scoDmDraft;
    return drawerShell(state.scoDmEditId ? 'Edit Member' : 'New Member', 'GraphQL: upsertScorecardDimensionMember', `
      <div class="field"><label>Code</label><input data-wf="sco-dm-field" data-id="code" value="${esc(d.code)}" /></div>
      <div class="field" style="margin-top:10px"><label>Name</label><input data-wf="sco-dm-field" data-id="name" value="${esc(d.name)}" /></div>
    `, `<button class="btn" data-wf="close-drawer">Cancel</button>`, `<button class="btn btn-primary" data-wf="sco-dm-save">Save</button>`);
  }
  return '';
}

export function handle(state, act, id, value) {
  // Source Systems
  if (act === 'sco-sys-open') { state.scoSysEditId = null; state.scoSysDraft = { name: '', provider: '' }; state.drawer = 'sco-sys-edit'; return true; }
  if (act === 'sco-sys-edit') { const s = state.wf.scoSystems.rows.find((x) => x.id === id); state.scoSysEditId = id; state.scoSysDraft = { name: s.name, provider: s.provider }; state.drawer = 'sco-sys-edit'; return true; }
  if (act === 'sco-sys-field') { state.scoSysDraft[id] = value; return true; }
  if (act === 'sco-sys-save') {
    if (!state.scoSysDraft.name.trim() || !state.scoSysDraft.provider.trim()) { toast('Name and provider are required.'); return true; }
    Api.analyticsGql(UPSERT_SYSTEM, { id: state.scoSysEditId, name: state.scoSysDraft.name.trim(), provider: state.scoSysDraft.provider.trim(), connectorId: null })
      .then(() => { state.drawer = null; state.wf.scoSystems = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-sys-delete') { if (!confirm('Delete this source system?')) return true; Api.analyticsGql(DELETE_SYSTEM, { id }).then(() => { toast('Deleted.'); state.wf.scoSystems = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // Source Measures
  if (act === 'sco-mea-select-system') { state.scoMeasuresSystemId = value; state.wf.scoMeasures = null; return true; }
  if (act === 'sco-mea-refresh') { state.wf.scoMeasures = null; return true; }
  if (act === 'sco-mea-open') { state.scoMeaEditId = null; state.scoMeaDraft = { code: '', name: '', description: '', unit: '' }; state.drawer = 'sco-mea-edit'; return true; }
  if (act === 'sco-mea-edit') { const m = state.wf.scoMeasures.rows.find((x) => x.id === id); state.scoMeaEditId = id; state.scoMeaDraft = { code: m.code, name: m.name, description: m.description || '', unit: m.unit || '' }; state.drawer = 'sco-mea-edit'; return true; }
  if (act === 'sco-mea-field') { state.scoMeaDraft[id] = value; return true; }
  if (act === 'sco-mea-save') {
    const d = state.scoMeaDraft;
    if (!d.code.trim() || !d.name.trim()) { toast('Code and name are required.'); return true; }
    Api.analyticsGql(UPSERT_MEASURE, { id: state.scoMeaEditId, sourceSystemId: state.scoMeasuresSystemId, code: d.code.trim(), name: d.name.trim(), description: d.description.trim() || null, unit: d.unit.trim() || null })
      .then(() => { state.drawer = null; state.wf.scoMeasures = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-mea-delete') { if (!confirm('Delete this measure?')) return true; Api.analyticsGql(DELETE_MEASURE, { id }).then(() => { toast('Deleted.'); state.wf.scoMeasures = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // Source Codes
  if (act === 'sco-cod-select-system') { state.scoCodesSystemId = value; state.wf.scoCodes = null; return true; }
  if (act === 'sco-cod-refresh') { state.wf.scoCodes = null; return true; }
  if (act === 'sco-cod-open') { state.scoCodEditId = null; state.scoCodDraft = { code: '', description: '' }; state.drawer = 'sco-cod-edit'; return true; }
  if (act === 'sco-cod-edit') { const c = state.wf.scoCodes.rows.find((x) => x.id === id); state.scoCodEditId = id; state.scoCodDraft = { code: c.code, description: c.description || '' }; state.drawer = 'sco-cod-edit'; return true; }
  if (act === 'sco-cod-field') { state.scoCodDraft[id] = value; return true; }
  if (act === 'sco-cod-save') {
    if (!state.scoCodDraft.code.trim()) { toast('Code is required.'); return true; }
    Api.analyticsGql(UPSERT_CODE, { id: state.scoCodEditId, sourceSystemId: state.scoCodesSystemId, code: state.scoCodDraft.code.trim(), description: state.scoCodDraft.description.trim() || null })
      .then(() => { state.drawer = null; state.wf.scoCodes = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-cod-delete') { if (!confirm('Delete this code?')) return true; Api.analyticsGql(DELETE_CODE, { id }).then(() => { toast('Deleted.'); state.wf.scoCodes = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // Source Mappings
  if (act === 'sco-map-select-system') { state.scoMapSystemId = value; state.scoMapMeasureId = null; state.wf.scoMapMeasures = null; state.wf.scoMappings = null; return true; }
  if (act === 'sco-map-select-measure') { state.scoMapMeasureId = value; state.wf.scoMappings = null; return true; }
  if (act === 'sco-map-refresh') { state.wf.scoMappings = null; return true; }
  if (act === 'sco-map-open') { state.scoMapEditId = null; state.scoMapDraft = { targetMetric: '', description: '' }; state.drawer = 'sco-map-edit'; return true; }
  if (act === 'sco-map-edit') { const m = state.wf.scoMappings.rows.find((x) => x.id === id); state.scoMapEditId = id; state.scoMapDraft = { targetMetric: m.targetMetric, description: m.description || '' }; state.drawer = 'sco-map-edit'; return true; }
  if (act === 'sco-map-field') { state.scoMapDraft[id] = value; return true; }
  if (act === 'sco-map-save') {
    if (!state.scoMapDraft.targetMetric.trim()) { toast('Target metric is required.'); return true; }
    Api.analyticsGql(UPSERT_MAPPING, { id: state.scoMapEditId, sourceMeasureId: state.scoMapMeasureId, targetMetric: state.scoMapDraft.targetMetric.trim(), description: state.scoMapDraft.description.trim() || null })
      .then(() => { state.drawer = null; state.wf.scoMappings = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-map-delete') { if (!confirm('Delete this mapping?')) return true; Api.analyticsGql(DELETE_MAPPING, { id }).then(() => { toast('Deleted.'); state.wf.scoMappings = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // Dimension Types
  if (act === 'sco-dt-open') { state.scoDtEditId = null; state.scoDtDraft = { name: '', description: '' }; state.drawer = 'sco-dt-edit'; return true; }
  if (act === 'sco-dt-edit') { const t = state.wf.scoDimTypes.rows.find((x) => x.id === id); state.scoDtEditId = id; state.scoDtDraft = { name: t.name, description: t.description || '' }; state.drawer = 'sco-dt-edit'; return true; }
  if (act === 'sco-dt-field') { state.scoDtDraft[id] = value; return true; }
  if (act === 'sco-dt-save') {
    if (!state.scoDtDraft.name.trim()) { toast('Name is required.'); return true; }
    Api.analyticsGql(UPSERT_DIM_TYPE, { id: state.scoDtEditId, name: state.scoDtDraft.name.trim(), description: state.scoDtDraft.description.trim() || null })
      .then(() => { state.drawer = null; state.wf.scoDimTypes = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-dt-delete') { if (!confirm('Delete this dimension type?')) return true; Api.analyticsGql(DELETE_DIM_TYPE, { id }).then(() => { toast('Deleted.'); state.wf.scoDimTypes = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // Dimension Members
  if (act === 'sco-dm-select-type') { state.scoDimMembersTypeId = value; state.wf.scoDimMembers = null; return true; }
  if (act === 'sco-dm-refresh') { state.wf.scoDimMembers = null; return true; }
  if (act === 'sco-dm-open') { state.scoDmEditId = null; state.scoDmDraft = { code: '', name: '' }; state.drawer = 'sco-dm-edit'; return true; }
  if (act === 'sco-dm-edit') { const m = state.wf.scoDimMembers.rows.find((x) => x.id === id); state.scoDmEditId = id; state.scoDmDraft = { code: m.code, name: m.name }; state.drawer = 'sco-dm-edit'; return true; }
  if (act === 'sco-dm-field') { state.scoDmDraft[id] = value; return true; }
  if (act === 'sco-dm-save') {
    const d = state.scoDmDraft;
    if (!d.code.trim() || !d.name.trim()) { toast('Code and name are required.'); return true; }
    Api.analyticsGql(UPSERT_DIM_MEMBER, { id: state.scoDmEditId, dimensionTypeId: state.scoDimMembersTypeId, code: d.code.trim(), name: d.name.trim() })
      .then(() => { state.drawer = null; state.wf.scoDimMembers = null; toast('Saved.'); doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-dm-delete') { if (!confirm('Delete this member?')) return true; Api.analyticsGql(DELETE_DIM_MEMBER, { id }).then(() => { toast('Deleted.'); state.wf.scoDimMembers = null; doRerender(); }).catch((err) => toast(errMsg(err))); return true; }

  // F&S Queue Mappings
  if (act === 'sco-fs-select-campaign') { state.scoFsCampaignId = value; state.wf.scoCampaignQueues = null; return true; }
  if (act === 'sco-fs-refresh') { state.wf.scoCampaignQueues = null; state.wf.scoCcQueues = null; return true; }
  if (act === 'sco-fs-add-select') { state.scoFsAddOrgUnitId = value; return true; }
  if (act === 'sco-fs-add') {
    if (!state.scoFsAddOrgUnitId) { toast('Select a queue first.'); return true; }
    Api.forecastingApi(`/v1/forecasting/campaigns/${state.scoFsCampaignId}/queues`, { method: 'POST', body: { orgUnitId: state.scoFsAddOrgUnitId } })
      .then(() => { toast('Queue added to campaign.'); state.wf.scoCampaignQueues = null; doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sco-fs-remove') {
    Api.forecastingApi(`/v1/forecasting/campaigns/${state.scoFsCampaignId}/queues/${id}`, { method: 'DELETE' })
      .then(() => { toast('Queue removed from campaign.'); state.wf.scoCampaignQueues = null; doRerender(); }).catch((err) => toast(errMsg(err)));
    return true;
  }

  return false;
}
