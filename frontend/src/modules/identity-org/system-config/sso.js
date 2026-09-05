/* System Configuration → Authentication (SSO/SAML/OIDC). Full CRUD over the
   already-real, already-audited /v1/identity-providers backend
   (src/modules/sso/) — zero frontend existed for this anywhere before now.
   Test Connection is real: OIDC discovery fetch / SAML cert well-formedness
   check, POST /v1/identity-providers/:id/test-connection. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell } from '../shared/ui.js';

function loadIdentityProviders(state) {
  state.wf.identityProviders = { loading: true };
  Api.rootApi('/v1/identity-providers')
    .then((rows) => {
      state.wf.identityProviders = { rows };
      doRerender();
    })
    .catch((err) => {
      state.wf.identityProviders = { error: errMsg(err) };
      doRerender();
    });
}

function emptyIdpDraft(editing) {
  const am = (editing && editing.attributeMapping) || {};
  return {
    protocol: editing ? editing.protocol : 'oidc',
    name: editing ? editing.name : '',
    isActive: editing ? editing.isActive : true,
    oidcDiscoveryUrl: (editing && editing.oidcDiscoveryUrl) || '',
    oidcClientId: (editing && editing.oidcClientId) || '',
    oidcClientSecret: '',
    samlEntityId: (editing && editing.samlEntityId) || '',
    samlSsoUrl: (editing && editing.samlSsoUrl) || '',
    samlSloUrl: (editing && editing.samlSloUrl) || '',
    samlCertificate: (editing && editing.samlCertificate) || '',
    attrEmail: am.email || '',
    attrGivenName: am.givenName || '',
    attrFamilyName: am.familyName || '',
    attrGroups: am.groups || '',
  };
}

export function render(state) {
  if (!state.wf.identityProviders) loadIdentityProviders(state);
  const list = state.wf.identityProviders;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No identity providers configured.', 'Add a SAML or OIDC provider to let users sign in through your own IdP.')
        : `<table class="data"><thead><tr><th>Name</th><th>Protocol</th><th>Status</th><th></th></tr></thead><tbody>
            ${list.rows.map((p) => `<tr>
              <td><b>${esc(p.name)}</b></td>
              <td class="mono">${p.protocol.toUpperCase()}</td>
              <td>${stBadge(p.isActive ? 'ACTIVE' : 'DISABLED')}</td>
              <td>
                <button class="btn btn-sm" data-wf="sc-idp-test" data-id="${p.id}" ${state.wf.saving['scIdpTest' + p.id] ? 'disabled' : ''}>${state.wf.saving['scIdpTest' + p.id] ? 'Testing…' : 'Test Connection'}</button>
                <button class="btn btn-sm" data-wf="sc-idp-edit" data-id="${p.id}">Edit</button>
                <button class="btn btn-sm" data-wf="sc-idp-delete" data-id="${p.id}">Delete</button>
              </td>
            </tr>
            ${state.scIdpTestResult && state.scIdpTestResult.id === p.id ? `<tr><td colspan="4" class="${state.scIdpTestResult.success ? '' : 'muted'}">${esc(state.scIdpTestResult.message)}</td></tr>` : ''}`).join('')}
          </tbody></table>`;
  return `
    ${pageHead('Authentication', 'SAML and OIDC identity providers for single sign-on.', `<button class="btn btn-primary" data-wf="sc-idp-open">+ Add identity provider</button>`)}
    ${sec('Identity providers', body)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'sc-idp') return '';
  const editing = state.scIdpEditTarget;
  const d = state.scIdpDraft;
  const saving = state.wf.saving.scIdp;
  return drawerShell(
    editing ? `Edit ${esc(editing.name)}` : 'Add identity provider',
    editing ? "Update this identity provider's configuration." : 'Connect a new SSO identity provider.',
    `
    <div class="field"><label>Name</label><input data-wf="sc-idp-field" data-id="name" value="${esc(d.name)}" /></div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Protocol</label>
        <select data-wf="sc-idp-field" data-id="protocol" ${editing ? 'disabled' : ''}>
          <option value="oidc" ${d.protocol === 'oidc' ? 'selected' : ''}>OIDC</option>
          <option value="saml" ${d.protocol === 'saml' ? 'selected' : ''}>SAML</option>
        </select>
      </div>
      <div class="field"><label><input type="checkbox" data-wf="sc-idp-toggle" data-id="isActive" ${d.isActive ? 'checked' : ''} /> Active</label></div>
    </div>
    ${d.protocol === 'oidc' ? `
      <div class="field" style="margin-top:10px"><label>Discovery URL</label><input data-wf="sc-idp-field" data-id="oidcDiscoveryUrl" placeholder="https://idp.example.com/.well-known/openid-configuration" value="${esc(d.oidcDiscoveryUrl)}" /></div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Client ID</label><input data-wf="sc-idp-field" data-id="oidcClientId" value="${esc(d.oidcClientId)}" /></div>
        <div class="field"><label>Client secret ${editing && editing.oidcClientSecretSet ? '<span class="meta">(set — leave blank to keep)</span>' : ''}</label><input data-wf="sc-idp-field" data-id="oidcClientSecret" type="password" value="${esc(d.oidcClientSecret)}" /></div>
      </div>` : `
      <div class="field" style="margin-top:10px"><label>Entity ID</label><input data-wf="sc-idp-field" data-id="samlEntityId" value="${esc(d.samlEntityId)}" /></div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>SSO URL</label><input data-wf="sc-idp-field" data-id="samlSsoUrl" value="${esc(d.samlSsoUrl)}" /></div>
        <div class="field"><label>SLO URL</label><input data-wf="sc-idp-field" data-id="samlSloUrl" value="${esc(d.samlSloUrl)}" /></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Signing certificate (PEM)</label><textarea data-wf="sc-idp-field" data-id="samlCertificate" rows="4">${esc(d.samlCertificate)}</textarea></div>`}
    <div class="field" style="margin-top:10px"><label>Attribute mapping (optional — IdP claim/attribute names)</label>
      <div class="grid-2">
        <input data-wf="sc-idp-field" data-id="attrEmail" placeholder="email claim" value="${esc(d.attrEmail)}" />
        <input data-wf="sc-idp-field" data-id="attrGivenName" placeholder="given name claim" value="${esc(d.attrGivenName)}" />
      </div>
      <div class="grid-2" style="margin-top:6px">
        <input data-wf="sc-idp-field" data-id="attrFamilyName" placeholder="family name claim" value="${esc(d.attrFamilyName)}" />
        <input data-wf="sc-idp-field" data-id="attrGroups" placeholder="groups claim" value="${esc(d.attrGroups)}" />
      </div>
    </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? 'sc-idp-edit-go' : 'sc-idp-go'}" ${editing ? `data-id="${editing.id}"` : ''} ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : editing ? 'Save' : 'Create'}</button>`,
  );
}

function draftToDto(d) {
  const attributeMapping = d.attrEmail || d.attrGivenName || d.attrFamilyName || d.attrGroups
    ? { email: d.attrEmail || undefined, givenName: d.attrGivenName || undefined, familyName: d.attrFamilyName || undefined, groups: d.attrGroups || undefined }
    : undefined;
  const base = { name: d.name.trim(), isActive: d.isActive, attributeMapping };
  if (d.protocol === 'oidc') {
    return { ...base, oidcDiscoveryUrl: d.oidcDiscoveryUrl.trim() || undefined, oidcClientId: d.oidcClientId.trim() || undefined, oidcClientSecret: d.oidcClientSecret.trim() || undefined };
  }
  return { ...base, samlEntityId: d.samlEntityId.trim() || undefined, samlSsoUrl: d.samlSsoUrl.trim() || undefined, samlSloUrl: d.samlSloUrl.trim() || undefined, samlCertificate: d.samlCertificate.trim() || undefined };
}

export function handle(state, act, id, value) {
  if (act === 'sc-idp-open') {
    state.scIdpEditTarget = null;
    state.scIdpDraft = emptyIdpDraft(null);
    state.drawer = 'sc-idp';
    return true;
  }
  if (act === 'sc-idp-edit') {
    const target = (state.wf.identityProviders.rows || []).find((p) => p.id === id);
    state.scIdpEditTarget = target;
    state.scIdpDraft = emptyIdpDraft(target);
    state.drawer = 'sc-idp';
    return true;
  }
  if (act === 'sc-idp-field') {
    state.scIdpDraft[id] = value;
    return true;
  }
  if (act === 'sc-idp-toggle') {
    const el = document.querySelector(`[data-wf="sc-idp-toggle"][data-id="${id}"]`);
    state.scIdpDraft[id] = !!(el && el.checked);
    return true;
  }
  if (act === 'sc-idp-go' || act === 'sc-idp-edit-go') {
    const d = state.scIdpDraft;
    if (!d.name.trim()) {
      toast('Name is required.');
      return true;
    }
    state.wf.saving.scIdp = true;
    doRerender();
    const dto = draftToDto(d);
    const req = act === 'sc-idp-go'
      ? Api.rootApi('/v1/identity-providers', { method: 'POST', body: { ...dto, protocol: d.protocol } })
      : Api.rootApi(`/v1/identity-providers/${id}`, { method: 'PUT', body: dto });
    req
      .then(() => {
        state.wf.saving.scIdp = false;
        state.drawer = null;
        state.wf.identityProviders = null;
        toast(act === 'sc-idp-go' ? 'Identity provider created.' : 'Identity provider saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scIdp = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === 'sc-idp-delete') {
    if (!confirm('Delete this identity provider? Users who sign in through it will no longer be able to.')) return true;
    Api.rootApi(`/v1/identity-providers/${id}`, { method: 'DELETE' })
      .then(() => {
        state.wf.identityProviders = null;
        toast('Identity provider deleted.');
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === 'sc-idp-test') {
    state.wf.saving['scIdpTest' + id] = true;
    state.scIdpTestResult = null;
    doRerender();
    Api.rootApi(`/v1/identity-providers/${id}/test-connection`, { method: 'POST' })
      .then((result) => {
        state.wf.saving['scIdpTest' + id] = false;
        state.scIdpTestResult = { id, ...result };
        doRerender();
      })
      .catch((err) => {
        state.wf.saving['scIdpTest' + id] = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
