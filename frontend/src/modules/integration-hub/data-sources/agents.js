/* Data Sources → Agents (tenant-wide Agent Mapping). Real backend:
   EmployeeDataSource (core service) — full CRUD already existed
   (addEmployeeDataSource/updateEmployeeDataSource/removeEmployeeDataSource);
   WP2 added the tenant-wide employeeDataSources query. This screen uses the
   roster loader (loadEmployees, shared with Profiles) instead, since it
   already embeds each employee's own dataSources sub-resource in one call
   and gives real employeeNumber/orgUnitId context for display — the same
   real backend data, just joined at the source rather than client-side. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../../identity-org/shared/ui.js';
import { loadEmployees, loadOrgUnits } from '../../identity-org/shared/loaders.js';
import { listAcdConnectors } from '../../integration-hub/api.js';

const ADD_MUTATION = `mutation Add($input: CreateEmployeeDataSourceInput!) { addEmployeeDataSource(input: $input) { id } }`;
const UPDATE_MUTATION = `mutation Update($input: UpdateEmployeeDataSourceInput!) { updateEmployeeDataSource(input: $input) { id } }`;
const REMOVE_MUTATION = `mutation Remove($id: ID!) { removeEmployeeDataSource(id: $id) }`;

function orgName(state, orgUnitId) {
  const u = (state.data.orgUnits || []).find((x) => x.id === orgUnitId);
  return u ? u.name : '—';
}

function mappingRows(state) {
  const employees = state.wf.employees || [];
  const rows = [];
  employees.forEach((e) => {
    (e.dataSources || []).forEach((ds) => rows.push({ ...ds, employeeId: e.id, employeeNumber: e.employeeNumber, orgUnitId: e.orgUnitId }));
  });
  return rows;
}

function emptyDraft() {
  return { employeeId: '', dataSource: '', agentId: '', extension: '' };
}

export function render(state) {
  if (!state.wf.employees) loadEmployees(state);
  if (!state.data.orgUnits) loadOrgUnits(state);
  if (!state.dsaConnectors) { state.dsaConnectors = { loading: true }; listAcdConnectors().then((rows) => { state.dsaConnectors = { rows }; doRerender(); }).catch(() => { state.dsaConnectors = { rows: [] }; }); }

  if (!state.wf.employees) {
    return pageHead('Agents', 'Loading…', '') + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  let rows = mappingRows(state);
  const q = (state.dsaSearch || '').toLowerCase();
  if (q) rows = rows.filter((r) => `${r.employeeNumber} ${r.dataSource} ${r.agentId || ''} ${r.extension || ''}`.toLowerCase().includes(q));
  if (state.dsaFilterDataSource) rows = rows.filter((r) => r.dataSource === state.dsaFilterDataSource);

  const selected = state.dsaSelected || new Set();
  const dataSourceOptions = [...new Set(mappingRows(state).map((r) => r.dataSource))];

  const body = rows.length === 0
    ? empty('No agent mappings yet.', 'Map an external ACD agent identity to a WFM employee.', `<button class="btn btn-primary" data-wf="dsa-open">+ Add Agent Mapping</button>`)
    : `<table class="data"><thead><tr>
        <th><input type="checkbox" data-wf="dsa-select-all" ${selected.size && selected.size === rows.length ? 'checked' : ''} /></th>
        <th>Data Source</th><th>Employee</th><th>Organization</th><th>Agent ID</th><th>Extension</th><th></th>
      </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><input type="checkbox" data-wf="dsa-select" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''} /></td>
        <td class="mono">${esc(r.dataSource)}</td>
        <td>${esc(r.employeeNumber)}</td>
        <td>${esc(orgName(state, r.orgUnitId))}</td>
        <td class="mono">${esc(r.agentId || '—')}</td>
        <td class="mono">${esc(r.extension || '—')}</td>
        <td class="row-actions">
          <button class="btn btn-sm" data-wf="dsa-edit" data-id="${r.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-wf="dsa-delete" data-id="${r.id}">Delete</button>
        </td>
      </tr>`).join('')}
    </tbody></table>`;

  return `
    ${pageHead('Agents', 'External ACD agent identities mapped to WFM employees.', `<button class="btn btn-primary" data-wf="dsa-open">+ Add Agent Mapping</button>`)}
    ${sec('Agent Mappings', `
      <div class="toolbar">
        <input class="search" placeholder="Search…" data-wf="dsa-search" value="${esc(state.dsaSearch || '')}" />
        <select data-wf="dsa-filter-ds"><option value="">All data sources</option>${dataSourceOptions.map((d) => `<option value="${esc(d)}" ${state.dsaFilterDataSource === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
        <button class="btn" data-wf="dsa-select-none" ${selected.size ? '' : 'disabled'}>Select None</button>
        <button class="btn btn-danger" data-wf="dsa-delete-selected" ${selected.size ? '' : 'disabled'}>Delete Selected (${selected.size})</button>
        <button class="btn" data-wf="dsa-refresh">Refresh</button>
      </div>
      ${body}
    `)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'dsa-edit') return '';
  const d = state.dsaDraft;
  const saving = state.wf.saving.dsaMapping;
  const employees = state.wf.employees || [];
  const acdOptions = ((state.dsaConnectors && state.dsaConnectors.rows) || []).map((c) => c.provider);
  return drawerShell(
    state.dsaEditId ? 'Edit Agent Mapping' : 'Add Agent Mapping',
    'core service: addEmployeeDataSource / updateEmployeeDataSource',
    `
    <div class="field"><label>Employee</label>
      <select data-wf="dsa-field" data-id="employeeId" ${state.dsaEditId ? 'disabled' : ''}>
        <option value="">Select employee…</option>
        ${employees.map((e) => `<option value="${e.id}" ${d.employeeId === e.id ? 'selected' : ''}>${esc(e.employeeNumber)}${e.jobTitle ? ' — ' + esc(e.jobTitle) : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field" style="margin-top:10px"><label>Data Source</label>
      <input data-wf="dsa-field" data-id="dataSource" list="dsa-ds-list" value="${esc(d.dataSource)}" ${state.dsaEditId ? 'disabled' : ''} />
      <datalist id="dsa-ds-list">${acdOptions.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
    </div>
    <div class="field" style="margin-top:10px"><label>Agent ID</label><input data-wf="dsa-field" data-id="agentId" value="${esc(d.agentId)}" /></div>
    <div class="field" style="margin-top:10px"><label>Extension</label><input data-wf="dsa-field" data-id="extension" value="${esc(d.extension)}" /></div>
    `,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="dsa-save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`,
  );
}

export function handle(state, act, id, value) {
  if (act === 'dsa-search') { state.dsaSearch = value; return true; }
  if (act === 'dsa-filter-ds') { state.dsaFilterDataSource = value; return true; }
  if (act === 'dsa-refresh') { state.wf.employees = null; state.dsaSelected = new Set(); return true; }

  if (act === 'dsa-select') {
    state.dsaSelected = state.dsaSelected || new Set();
    if (value) state.dsaSelected.add(id); else state.dsaSelected.delete(id);
    return true;
  }
  if (act === 'dsa-select-all') {
    state.dsaSelected = value ? new Set(mappingRows(state).map((r) => r.id)) : new Set();
    return true;
  }
  if (act === 'dsa-select-none') { state.dsaSelected = new Set(); return true; }
  if (act === 'dsa-delete-selected') {
    if (!confirm(`Delete ${state.dsaSelected.size} agent mapping(s)?`)) return true;
    Promise.all([...state.dsaSelected].map((mappingId) => Api.gqlFetch(REMOVE_MUTATION, { id: mappingId })))
      .then(() => { toast('Mappings deleted.'); state.dsaSelected = new Set(); state.wf.employees = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === 'dsa-open') {
    state.dsaEditId = null;
    state.dsaDraft = emptyDraft();
    state.drawer = 'dsa-edit';
    return true;
  }
  if (act === 'dsa-edit') {
    const r = mappingRows(state).find((x) => x.id === id);
    state.dsaEditId = id;
    state.dsaDraft = { employeeId: r.employeeId, dataSource: r.dataSource, agentId: r.agentId || '', extension: r.extension || '' };
    state.drawer = 'dsa-edit';
    return true;
  }
  if (act === 'dsa-field') { state.dsaDraft[id] = value; return true; }
  if (act === 'dsa-save') {
    const d = state.dsaDraft;
    if (!state.dsaEditId && (!d.employeeId || !d.dataSource.trim())) { toast('Employee and Data Source are required.'); return true; }
    state.wf.saving.dsaMapping = true;
    doRerender();
    const req = state.dsaEditId
      ? Api.gqlFetch(UPDATE_MUTATION, { input: { id: state.dsaEditId, agentId: d.agentId.trim() || null, extension: d.extension.trim() || null } })
      : Api.gqlFetch(ADD_MUTATION, { input: { employeeId: d.employeeId, dataSource: d.dataSource.trim(), agentId: d.agentId.trim() || null, extension: d.extension.trim() || null } });
    req
      .then(() => {
        state.wf.saving.dsaMapping = false;
        state.drawer = null;
        state.wf.employees = null;
        toast('Agent mapping saved.');
        doRerender();
      })
      .catch((err) => { state.wf.saving.dsaMapping = false; toast(errMsg(err)); doRerender(); });
    return true;
  }
  if (act === 'dsa-delete') {
    if (!confirm('Delete this agent mapping?')) return true;
    Api.gqlFetch(REMOVE_MUTATION, { id })
      .then(() => { toast('Mapping deleted.'); state.wf.employees = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
