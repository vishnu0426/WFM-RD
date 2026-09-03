/* Data Sources → Data Source Groups (+ Queue Group Mapping). Real backend:
   integration-hub-service's DataSourceGroup/DataSourceGroupQueue GraphQL
   (WP3) for the group itself; forecasting-service's real CcQueue REST API
   (WP4) for the queues a group can contain — CcQueue is this platform's
   one real canonical Queue entity, reused here rather than duplicated. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell, fmtDt } from '../../identity-org/shared/ui.js';

const GROUPS_QUERY = `query($dataSourceId: ID) { dataSourceGroups(dataSourceId: $dataSourceId) { id dataSourceId name description type avgWorkTimeSeconds updatedAt } }`;
const UPSERT_GROUP_MUTATION = `mutation Upsert($id: ID, $dataSourceId: ID!, $name: String!, $description: String, $type: String, $avgWorkTimeSeconds: Float) {
  upsertDataSourceGroup(id: $id, dataSourceId: $dataSourceId, name: $name, description: $description, type: $type, avgWorkTimeSeconds: $avgWorkTimeSeconds) { id }
}`;
const DELETE_GROUP_MUTATION = `mutation Delete($id: ID!) { deleteDataSourceGroup(id: $id) }`;
const GROUP_QUEUES_QUERY = `query($groupId: ID!) { dataSourceGroupQueues(groupId: $groupId) { id groupId ccQueueId } }`;
const ADD_QUEUE_MUTATION = `mutation Add($groupId: ID!, $ccQueueId: ID!) { addDataSourceGroupQueue(groupId: $groupId, ccQueueId: $ccQueueId) { id } }`;
const REMOVE_QUEUE_MUTATION = `mutation Remove($groupId: ID!, $ccQueueId: ID!) { removeDataSourceGroupQueue(groupId: $groupId, ccQueueId: $ccQueueId) }`;

function loadConnectorsIfNeeded(state) {
  if (state.wf.connectors) return;
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(`query { connectors { id connectorType provider status } }`, {})
    .then((data) => { state.wf.connectors = { rows: data.connectors }; doRerender(); })
    .catch((err) => { state.wf.connectors = { error: errMsg(err) }; doRerender(); });
}

function loadGroups(state) {
  state.wf.dsGroups = { loading: true };
  Api.integrationHubGql(GROUPS_QUERY, { dataSourceId: state.dsgFilterDataSourceId || null })
    .then((data) => { state.wf.dsGroups = { rows: data.dataSourceGroups }; doRerender(); })
    .catch((err) => { state.wf.dsGroups = { error: errMsg(err) }; doRerender(); });
}

function loadGroupQueues(state, groupId) {
  state.wf.dsgQueues = { loading: true };
  Api.integrationHubGql(GROUP_QUEUES_QUERY, { groupId })
    .then((data) => { state.wf.dsgQueues = { rows: data.dataSourceGroupQueues }; doRerender(); })
    .catch((err) => { state.wf.dsgQueues = { error: errMsg(err) }; doRerender(); });
}

function loadCcQueues(state, dataSourceId) {
  state.wf.dsgCcQueues = { loading: true };
  Api.forecastingApi(`/v1/forecasting/cc-queues?data_source_id=${encodeURIComponent(dataSourceId)}`)
    .then((rows) => { state.wf.dsgCcQueues = { rows }; doRerender(); })
    .catch((err) => { state.wf.dsgCcQueues = { error: errMsg(err) }; doRerender(); });
}

function connectorLabel(state, id) {
  const rows = (state.wf.connectors && state.wf.connectors.rows) || [];
  const c = rows.find((x) => x.id === id);
  return c ? `${c.provider} (${c.connectorType})` : id;
}

function emptyGroupDraft(dataSourceId) {
  return { dataSourceId: dataSourceId || '', name: '', description: '', type: '', avgWorkTimeSeconds: '' };
}

export function render(state) {
  loadConnectorsIfNeeded(state);
  if (!state.wf.dsGroups) loadGroups(state);
  const connectors = (state.wf.connectors && state.wf.connectors.rows) || [];
  const list = state.wf.dsGroups;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No data source groups yet.', 'Group several external queues under one tenant-facing name.', `<button class="btn btn-primary" data-wf="dsg-open">+ Create Group</button>`)
        : `<table class="data"><thead><tr><th>Name</th><th>Data Source</th><th>Type</th><th>Avg Work Time</th><th></th></tr></thead><tbody>
            ${list.rows.map((g) => `<tr>
              <td>${esc(g.name)}</td>
              <td>${esc(connectorLabel(state, g.dataSourceId))}</td>
              <td>${esc(g.type || '—')}</td>
              <td>${g.avgWorkTimeSeconds != null ? `${g.avgWorkTimeSeconds}s` : '—'}</td>
              <td class="row-actions">
                <button class="btn btn-sm" data-wf="dsg-manage-queues" data-id="${g.id}">Queue Group Mapping</button>
                <button class="btn btn-sm" data-wf="dsg-edit" data-id="${g.id}">Edit</button>
                <button class="btn btn-sm btn-danger" data-wf="dsg-delete" data-id="${g.id}">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody></table>`;
  return `
    ${pageHead('Data Source Groups', 'Aggregate several external queues under one tenant-facing group.', `<button class="btn btn-primary" data-wf="dsg-open">+ Create Group</button>`)}
    ${sec('Groups', `
      <div class="toolbar">
        <select data-wf="dsg-filter-ds"><option value="">All data sources</option>${connectors.map((c) => `<option value="${c.id}" ${state.dsgFilterDataSourceId === c.id ? 'selected' : ''}>${esc(c.provider)} (${esc(c.connectorType)})</option>`).join('')}</select>
        <button class="btn" data-wf="dsg-refresh">Refresh</button>
      </div>
      ${body}
    `, `<span class="meta">GraphQL: dataSourceGroups</span>`)}`;
}

export function renderDrawer(state) {
  if (state.drawer === 'dsg-edit') {
    const connectors = (state.wf.connectors && state.wf.connectors.rows) || [];
    const d = state.dsgDraft;
    const saving = state.wf.saving.dsgGroup;
    return drawerShell(
      state.dsgEditId ? 'Edit Data Source Group' : 'Create Data Source Group',
      'GraphQL: upsertDataSourceGroup',
      `
      <div class="field"><label>Data Source</label>
        <select data-wf="dsg-field" data-id="dataSourceId">${connectors.map((c) => `<option value="${c.id}" ${d.dataSourceId === c.id ? 'selected' : ''}>${esc(c.provider)} (${esc(c.connectorType)})</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-top:10px"><label>Name</label><input data-wf="dsg-field" data-id="name" value="${esc(d.name)}" /></div>
      <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="dsg-field" data-id="description" value="${esc(d.description)}" /></div>
      <div class="field" style="margin-top:10px"><label>Type</label><input data-wf="dsg-field" data-id="type" placeholder="e.g. Skill Group" value="${esc(d.type)}" /></div>
      <div class="field" style="margin-top:10px"><label>Average Work Time (seconds)</label><input type="number" data-wf="dsg-field" data-id="avgWorkTimeSeconds" value="${esc(d.avgWorkTimeSeconds)}" /></div>
      `,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="dsg-save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`,
    );
  }
  if (state.drawer === 'dsg-queues') {
    const group = (state.wf.dsGroups && state.wf.dsGroups.rows || []).find((g) => g.id === state.dsgQueuesGroupId);
    if (!group) return '';
    if (!state.wf.dsgQueues) loadGroupQueues(state, group.id);
    if (!state.wf.dsgCcQueues) loadCcQueues(state, group.dataSourceId);
    const queues = state.wf.dsgQueues;
    const ccQueues = (state.wf.dsgCcQueues && state.wf.dsgCcQueues.rows) || [];
    const memberIds = new Set((queues && queues.rows || []).map((q) => q.ccQueueId));
    const available = ccQueues.filter((q) => !memberIds.has(q.id));
    return drawerShell(
      `Queue Group Mapping — ${esc(group.name)}`,
      'forecasting-service CcQueue — the canonical WFM queue entity',
      `
      <div class="field">
        <label>Add queue</label>
        <div style="display:flex;gap:8px">
          <select data-wf="dsg-add-queue-select" style="flex:1">
            <option value="">Select a queue…</option>
            ${available.map((q) => `<option value="${q.id}">${esc(q.name)} (${esc(q.externalQueueId)})</option>`).join('')}
          </select>
          <button class="btn" data-wf="dsg-add-queue">Add</button>
        </div>
      </div>
      <h4 style="margin:16px 0 8px">Mapped queues</h4>
      ${!queues || queues.loading
        ? '<div class="skel" style="height:20px"></div>'
        : queues.error
          ? `<p class="muted">${esc(queues.error)}</p>`
          : queues.rows.length === 0
            ? '<p class="muted">No queues mapped to this group yet.</p>'
            : `<table class="data"><thead><tr><th>Queue</th><th>External Queue ID</th><th></th></tr></thead><tbody>
                ${queues.rows.map((q) => {
                  const cc = ccQueues.find((x) => x.id === q.ccQueueId);
                  return `<tr><td>${esc(cc ? cc.name : q.ccQueueId)}</td><td class="mono">${esc(cc ? cc.externalQueueId : '—')}</td>
                    <td><button class="btn btn-sm btn-danger" data-wf="dsg-remove-queue" data-id="${q.ccQueueId}">Remove</button></td></tr>`;
                }).join('')}
              </tbody></table>`}
      `,
      `<button class="btn" data-wf="close-drawer">Close</button>`,
      '',
    );
  }
  return '';
}

export function handle(state, act, id, value) {
  if (act === 'dsg-filter-ds') { state.dsgFilterDataSourceId = value; state.wf.dsGroups = null; return true; }
  if (act === 'dsg-refresh') { state.wf.dsGroups = null; return true; }

  if (act === 'dsg-open') {
    state.dsgEditId = null;
    state.dsgDraft = emptyGroupDraft(state.dsgFilterDataSourceId);
    state.drawer = 'dsg-edit';
    return true;
  }
  if (act === 'dsg-edit') {
    const g = state.wf.dsGroups.rows.find((x) => x.id === id);
    state.dsgEditId = id;
    state.dsgDraft = { dataSourceId: g.dataSourceId, name: g.name, description: g.description || '', type: g.type || '', avgWorkTimeSeconds: g.avgWorkTimeSeconds ?? '' };
    state.drawer = 'dsg-edit';
    return true;
  }
  if (act === 'dsg-field') { state.dsgDraft[id] = value; return true; }
  if (act === 'dsg-save') {
    const d = state.dsgDraft;
    if (!d.dataSourceId || !d.name.trim()) { toast('Data source and name are required.'); return true; }
    state.wf.saving.dsgGroup = true;
    doRerender();
    Api.integrationHubGql(UPSERT_GROUP_MUTATION, {
      id: state.dsgEditId,
      dataSourceId: d.dataSourceId,
      name: d.name.trim(),
      description: d.description.trim() || null,
      type: d.type.trim() || null,
      avgWorkTimeSeconds: d.avgWorkTimeSeconds === '' ? null : Number(d.avgWorkTimeSeconds),
    })
      .then(() => {
        state.wf.saving.dsgGroup = false;
        state.drawer = null;
        state.wf.dsGroups = null;
        toast('Group saved.');
        doRerender();
      })
      .catch((err) => { state.wf.saving.dsgGroup = false; toast(errMsg(err)); doRerender(); });
    return true;
  }
  if (act === 'dsg-delete') {
    if (!confirm('Delete this data source group? Queue mappings under it are removed too.')) return true;
    Api.integrationHubGql(DELETE_GROUP_MUTATION, { id })
      .then(() => { toast('Group deleted.'); state.wf.dsGroups = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === 'dsg-manage-queues') {
    state.dsgQueuesGroupId = id;
    state.wf.dsgQueues = null;
    state.wf.dsgCcQueues = null;
    state.drawer = 'dsg-queues';
    return true;
  }
  if (act === 'dsg-add-queue-select') { state.dsgAddQueueId = value; return true; }
  if (act === 'dsg-add-queue') {
    if (!state.dsgAddQueueId) { toast('Select a queue first.'); return true; }
    Api.integrationHubGql(ADD_QUEUE_MUTATION, { groupId: state.dsgQueuesGroupId, ccQueueId: state.dsgAddQueueId })
      .then(() => { toast('Queue added.'); state.wf.dsgQueues = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'dsg-remove-queue') {
    Api.integrationHubGql(REMOVE_QUEUE_MUTATION, { groupId: state.dsgQueuesGroupId, ccQueueId: id })
      .then(() => { toast('Queue removed.'); state.wf.dsgQueues = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
