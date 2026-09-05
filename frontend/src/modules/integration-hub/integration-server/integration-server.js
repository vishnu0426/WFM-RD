/* Integration Server → Integration Servers. Real backend:
   integration-hub-service's IntegrationServer/IntegrationConnectorServer
   GraphQL. This is a real, persisted inventory of a tenant's own on-prem
   recording infrastructure - fields and the eight role names are grounded
   in Verint WFO/EMT's actual "Server"/"Recorder Integration Service" admin
   screens (confirmed live during implementation:
   https://wfo.mon2.verintcloudservices.com/onlinehelp/en_us/emt/rec_EM_EM_Config_Admin_Guide/rec_EM_Create_a_Server__Windows_domain_.htm,
   https://wfo.f2.verintcloudservices.com/OnlineHelp_en/emt/Recorder_config/rec_RecCfg_Roles.htm).
   This is deliberately a registry, not a control plane - nothing on this
   platform opens an RMI/TDM/SIP connection to a row here; see
   IntegrationServer's own doc comment server-side. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell, fmtDt } from '../../identity-org/shared/ui.js';

const ROLES = [
  { id: 'RECORDER_INTEGRATION_SERVICE', label: 'Recorder Integration Service (RIS)' },
  { id: 'IP_RECORDER', label: 'IP Recorder' },
  { id: 'TDM_RECORDER', label: 'TDM Recorder' },
  { id: 'SCREEN_RECORDER', label: 'Screen Recorder' },
  { id: 'RECORDER_ADAPTER_PROXY_SERVICE', label: 'Recorder Adapter Proxy Service (RAPS)' },
  { id: 'CONTENT_SERVER', label: 'Content Server' },
  { id: 'IP_ANALYZER', label: 'IP Analyzer' },
  { id: 'CENTRAL_ARCHIVE', label: 'Central Archive' },
];

const SERVERS_QUERY = `query { integrationServers { id name description serverName portNumber httpsPortNumber httpAlias blocked roles updatedAt } }`;
const UPSERT_MUTATION = `mutation Upsert(
  $id: ID, $name: String!, $serverName: String!, $roles: [IntegrationServerRole!]!,
  $description: String, $portNumber: Float, $httpsPortNumber: Float, $httpAlias: String, $blocked: Boolean
) {
  upsertIntegrationServer(
    id: $id, name: $name, serverName: $serverName, roles: $roles,
    description: $description, portNumber: $portNumber, httpsPortNumber: $httpsPortNumber, httpAlias: $httpAlias, blocked: $blocked
  ) { id }
}`;
const DELETE_MUTATION = `mutation Delete($id: ID!) { deleteIntegrationServer(id: $id) }`;

function loadServers(state) {
  state.wf.integrationServers = { loading: true };
  Api.integrationHubGql(SERVERS_QUERY, {})
    .then((data) => { state.wf.integrationServers = { rows: data.integrationServers }; doRerender(); })
    .catch((err) => { state.wf.integrationServers = { error: errMsg(err) }; doRerender(); });
}

function emptyDraft() {
  return { name: '', description: '', serverName: '', portNumber: '', httpsPortNumber: '', httpAlias: '', blocked: false, roles: [] };
}

function roleLabels(roles) {
  return (roles || []).map((r) => (ROLES.find((x) => x.id === r) || { label: r }).label).join(', ') || '—';
}

export function render(state) {
  if (!state.wf.integrationServers) loadServers(state);
  const list = state.wf.integrationServers;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No integration servers registered yet.', 'Document your on-prem recording infrastructure — this is a real, persisted inventory, not a live connection.', `<button class="btn btn-primary" data-wf="is-open">+ Register Server</button>`)
        : `<table class="data"><thead><tr><th>Name</th><th>Server Name</th><th>Ports</th><th>Roles</th><th>Blocked</th><th>Updated</th><th></th></tr></thead><tbody>
            ${list.rows.map((s) => `<tr>
              <td>${esc(s.name)}</td>
              <td class="mono">${esc(s.serverName)}</td>
              <td>${s.portNumber ?? '—'} / ${s.httpsPortNumber ?? '—'}${s.httpAlias ? ` (alias: ${esc(s.httpAlias)})` : ''}</td>
              <td>${esc(roleLabels(s.roles))}</td>
              <td>${s.blocked ? '<span class="badge badge-warn">Blocked</span>' : '<span class="badge badge-ok">Active</span>'}</td>
              <td>${fmtDt(s.updatedAt)}</td>
              <td class="row-actions">
                <button class="btn btn-sm" data-wf="is-edit" data-id="${s.id}">Edit</button>
                <button class="btn btn-sm btn-danger" data-wf="is-delete" data-id="${s.id}">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody></table>`;
  return `
    ${pageHead('Integration Servers', 'A real, persisted inventory of your own on-prem recording infrastructure — documentation, not a live control plane.', `<button class="btn btn-primary" data-wf="is-open">+ Register Server</button>`)}
    ${sec('Integration Servers', `
      <div class="toolbar"><button class="btn" data-wf="is-refresh">Refresh</button></div>
      ${body}
    `, `<span class="meta">GraphQL: integrationServers</span>`)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'is-edit') return '';
  const d = state.isDraft;
  const saving = state.wf.saving.isServer;
  return drawerShell(
    state.isEditId ? 'Edit Integration Server' : 'Register Integration Server',
    'GraphQL: upsertIntegrationServer — real field names from Verint WFO/EMT\'s own "Create Server" admin screen',
    `
    <div class="grid-2">
      <div class="field"><label>Name</label><input data-wf="is-field" data-id="name" value="${esc(d.name)}" /></div>
      <div class="field"><label>Server Name (host, FQDN, or IP)</label><input data-wf="is-field" data-id="serverName" placeholder="e.g. ris01.onprem.customer.local" value="${esc(d.serverName)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="is-field" data-id="description" value="${esc(d.description)}" /></div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Port Number (HTTP)</label><input type="number" data-wf="is-field" data-id="portNumber" value="${esc(d.portNumber)}" /></div>
      <div class="field"><label>HTTPS Port Number</label><input type="number" data-wf="is-field" data-id="httpsPortNumber" value="${esc(d.httpsPortNumber)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>HTTP Alias (load-balancer address, clustered deployments)</label><input data-wf="is-field" data-id="httpAlias" value="${esc(d.httpAlias)}" /></div>
    <div class="field" style="margin-top:10px">
      <label><input type="checkbox" data-wf="is-field" data-id="blocked" ${d.blocked ? 'checked' : ''} /> Blocked (prevents this server from receiving configuration messages)</label>
    </div>
    <h4 style="margin:16px 0 8px">Roles</h4>
    ${ROLES.map((r) => `
      <div class="field" style="margin-top:6px">
        <label><input type="checkbox" data-wf="is-role-toggle" data-id="${r.id}" ${d.roles.includes(r.id) ? 'checked' : ''} /> ${esc(r.label)}</label>
      </div>`).join('')}
    `,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="is-save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`,
  );
}

export function handle(state, act, id, value) {
  if (act === 'is-refresh') { state.wf.integrationServers = null; return true; }
  if (act === 'is-open') {
    state.isEditId = null;
    state.isDraft = emptyDraft();
    state.drawer = 'is-edit';
    return true;
  }
  if (act === 'is-edit') {
    const s = state.wf.integrationServers.rows.find((x) => x.id === id);
    state.isEditId = id;
    state.isDraft = {
      name: s.name, description: s.description || '', serverName: s.serverName,
      portNumber: s.portNumber ?? '', httpsPortNumber: s.httpsPortNumber ?? '', httpAlias: s.httpAlias || '',
      blocked: !!s.blocked, roles: [...s.roles],
    };
    state.drawer = 'is-edit';
    return true;
  }
  if (act === 'is-field') {
    // Checkbox fields (only `blocked`) go through the same click-then-
    // preventDefault path every other checkbox in this app does (see
    // data-sources.js's own note on this) - flip, don't trust the value.
    state.isDraft[id] = id === 'blocked' ? !state.isDraft[id] : value;
    return true;
  }
  if (act === 'is-role-toggle') {
    const roles = state.isDraft.roles;
    state.isDraft.roles = roles.includes(id) ? roles.filter((r) => r !== id) : [...roles, id];
    return true;
  }
  if (act === 'is-save') {
    const d = state.isDraft;
    if (!d.name.trim() || !d.serverName.trim()) { toast('Name and Server Name are required.'); return true; }
    state.wf.saving.isServer = true;
    doRerender();
    Api.integrationHubGql(UPSERT_MUTATION, {
      id: state.isEditId,
      name: d.name.trim(),
      serverName: d.serverName.trim(),
      roles: d.roles,
      description: d.description.trim() || null,
      portNumber: d.portNumber === '' ? null : Number(d.portNumber),
      httpsPortNumber: d.httpsPortNumber === '' ? null : Number(d.httpsPortNumber),
      httpAlias: d.httpAlias.trim() || null,
      blocked: d.blocked,
    })
      .then(() => {
        state.wf.saving.isServer = false;
        state.drawer = null;
        state.wf.integrationServers = null;
        toast('Integration server saved.');
        doRerender();
      })
      .catch((err) => { state.wf.saving.isServer = false; toast(errMsg(err)); doRerender(); });
    return true;
  }
  if (act === 'is-delete') {
    if (!confirm('Delete this integration server? Any data source associations to it are removed too.')) return true;
    Api.integrationHubGql(DELETE_MUTATION, { id })
      .then(() => { toast('Integration server deleted.'); state.wf.integrationServers = null; doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
