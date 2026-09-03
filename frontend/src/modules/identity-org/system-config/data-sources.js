/* System Configuration → Data Sources. Tenant's own self-service connectors,
   via integration-hub-service's real GraphQL (connectors / createConnector)
   — distinct from Platform Admin's read-only cross-tenant status view built
   earlier this session. No edit/delete — the backend doesn't expose them. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell, fmtDt } from '../shared/ui.js';

const CONNECTOR_TYPES = ['HRIS', 'PAYROLL', 'ACD', 'CRM', 'CUSTOM_WEBHOOK'];

const LIST_QUERY = `query { connectors { id connectorType provider status lastSyncAt lastSyncStatus } }`;
const CREATE_MUTATION = `mutation Create(
  $connectorType: ConnectorType!, $provider: String!, $credentials: JSON,
  $oauthClientId: String, $oauthClientSecret: String, $oauthAuthorizationEndpoint: String,
  $oauthTokenEndpoint: String, $oauthRedirectUri: String, $oauthScope: String
) {
  createConnector(
    connectorType: $connectorType, provider: $provider, credentials: $credentials,
    oauthClientId: $oauthClientId, oauthClientSecret: $oauthClientSecret,
    oauthAuthorizationEndpoint: $oauthAuthorizationEndpoint, oauthTokenEndpoint: $oauthTokenEndpoint,
    oauthRedirectUri: $oauthRedirectUri, oauthScope: $oauthScope
  ) { authorizationUrl connector { id connectorType provider status } }
}`;

function loadConnectors(state) {
  state.wf.connectors = { loading: true };
  Api.integrationHubGql(LIST_QUERY, {})
    .then((data) => {
      state.wf.connectors = { rows: data.connectors };
      doRerender();
    })
    .catch((err) => {
      state.wf.connectors = { error: errMsg(err) };
      doRerender();
    });
}

function emptyConnectorDraft() {
  return {
    connectorType: CONNECTOR_TYPES[0],
    provider: '',
    authMode: 'credentials',
    credentialsJson: '{\n  \n}',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthAuthorizationEndpoint: '',
    oauthTokenEndpoint: '',
    oauthRedirectUri: '',
    oauthScope: '',
  };
}

export function render(state) {
  if (!state.wf.connectors) loadConnectors(state);
  const list = state.wf.connectors;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No data source connectors yet.', 'Connect an HRIS, payroll, ACD, or CRM system to bring real data into WFM.')
        : `<table class="data"><thead><tr><th>Type</th><th>Provider</th><th>Status</th><th>Last sync</th></tr></thead><tbody>
            ${list.rows.map((c) => `<tr>
              <td class="mono">${esc(c.connectorType)}</td>
              <td>${esc(c.provider)}</td>
              <td>${stBadge(c.status)}</td>
              <td>${c.lastSyncAt ? `${fmtDt(c.lastSyncAt)} (${esc(c.lastSyncStatus || '—')})` : '—'}</td>
            </tr>`).join('')}
          </tbody></table>`;
  return `
    ${pageHead('Data Sources', 'This tenant’s own integration connectors.', `<button class="btn btn-primary" data-wf="sc-connector-open">+ New connector</button>`)}
    ${sec('Connectors', body, `<span class="meta">GraphQL: connectors</span>`)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'sc-connector') return '';
  const d = state.scConnectorDraft;
  const saving = state.wf.saving.scConnector;
  return drawerShell(
    'New connector',
    'GraphQL: createConnector — exactly one of credentials or OAuth is required',
    `
    <div class="grid-2">
      <div class="field"><label>Type</label>
        <select data-wf="sc-connector-field" data-id="connectorType">${CONNECTOR_TYPES.map((t) => `<option value="${t}" ${d.connectorType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Provider</label><input data-wf="sc-connector-field" data-id="provider" placeholder="e.g. workday, adp, salesforce" value="${esc(d.provider)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Authentication</label>
      <select data-wf="sc-connector-field" data-id="authMode">
        <option value="credentials" ${d.authMode === 'credentials' ? 'selected' : ''}>API credentials</option>
        <option value="oauth" ${d.authMode === 'oauth' ? 'selected' : ''}>OAuth</option>
      </select>
    </div>
    ${d.authMode === 'credentials' ? `
      <div class="field" style="margin-top:10px"><label>Credentials (JSON — no fixed schema per provider)</label>
        <textarea data-wf="sc-connector-field" data-id="credentialsJson" rows="5" class="mono">${esc(d.credentialsJson)}</textarea>
      </div>` : `
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>OAuth client ID</label><input data-wf="sc-connector-field" data-id="oauthClientId" value="${esc(d.oauthClientId)}" /></div>
        <div class="field"><label>OAuth client secret</label><input data-wf="sc-connector-field" data-id="oauthClientSecret" type="password" value="${esc(d.oauthClientSecret)}" /></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Authorization endpoint</label><input data-wf="sc-connector-field" data-id="oauthAuthorizationEndpoint" value="${esc(d.oauthAuthorizationEndpoint)}" /></div>
      <div class="field" style="margin-top:10px"><label>Token endpoint</label><input data-wf="sc-connector-field" data-id="oauthTokenEndpoint" value="${esc(d.oauthTokenEndpoint)}" /></div>
      <div class="field" style="margin-top:10px"><label>Redirect URI</label><input data-wf="sc-connector-field" data-id="oauthRedirectUri" value="${esc(d.oauthRedirectUri)}" /></div>
      <div class="field" style="margin-top:10px"><label>Scope</label><input data-wf="sc-connector-field" data-id="oauthScope" value="${esc(d.oauthScope)}" /></div>`}
    `,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="sc-connector-go" ${saving ? 'disabled' : ''}>${saving ? 'Creating…' : 'Create'}</button>`,
  );
}

export function handle(state, act, id, value) {
  if (act === 'sc-connector-open') {
    state.scConnectorDraft = emptyConnectorDraft();
    state.drawer = 'sc-connector';
    return true;
  }
  if (act === 'sc-connector-field') {
    state.scConnectorDraft[id] = value;
    return true;
  }
  if (act === 'sc-connector-go') {
    const d = state.scConnectorDraft;
    if (!d.provider.trim()) {
      toast('Provider is required.');
      return true;
    }
    let credentials;
    if (d.authMode === 'credentials') {
      try {
        credentials = JSON.parse(d.credentialsJson);
      } catch {
        toast('Credentials must be valid JSON.');
        return true;
      }
    }
    state.wf.saving.scConnector = true;
    doRerender();
    const variables = {
      connectorType: d.connectorType,
      provider: d.provider.trim(),
      credentials: d.authMode === 'credentials' ? credentials : undefined,
      oauthClientId: d.authMode === 'oauth' ? d.oauthClientId.trim() || undefined : undefined,
      oauthClientSecret: d.authMode === 'oauth' ? d.oauthClientSecret.trim() || undefined : undefined,
      oauthAuthorizationEndpoint: d.authMode === 'oauth' ? d.oauthAuthorizationEndpoint.trim() || undefined : undefined,
      oauthTokenEndpoint: d.authMode === 'oauth' ? d.oauthTokenEndpoint.trim() || undefined : undefined,
      oauthRedirectUri: d.authMode === 'oauth' ? d.oauthRedirectUri.trim() || undefined : undefined,
      oauthScope: d.authMode === 'oauth' ? d.oauthScope.trim() || undefined : undefined,
    };
    Api.integrationHubGql(CREATE_MUTATION, variables)
      .then((data) => {
        state.wf.saving.scConnector = false;
        state.drawer = null;
        state.wf.connectors = null;
        if (data.createConnector.authorizationUrl) {
          toast('Connector created — complete OAuth consent to activate it.');
        } else {
          toast('Connector created.');
        }
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scConnector = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
