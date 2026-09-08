/* System Configuration → Security. Two independent, real backends:
   - Password Policy: PUT /v1/tenant-settings/security — now actually
     enforced by PasswordAuthService.setPassword (previously stored but
     never consulted; a hardcoded 12-char floor was used everywhere
     instead — fixed this same session).
   - Required Authentication Method: the generic, already-real, versioned
     /v1/policies API scoped to policyType=auth_method_policy — the actual
     mechanism AuthMethodPolicyService reads at login (OAuthController).
     TenantSettings.mfaRequired/sessionTimeoutMinutes are NOT shown here —
     confirmed dead columns with no real consumer. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';
import { loadSettings } from '../shared/loaders.js';

const AUTH_METHOD_POLICY_TYPE = 'auth_method_policy';
const ACCESS_RESTRICTION_POLICY_TYPE = 'access_restriction_policy';
const METHODS = [
  { id: 'pwd', label: 'Password' },
  { id: 'webauthn', label: 'WebAuthn (security key / platform authenticator)' },
];

function emptySecurityDraft(s) {
  return {
    passwordMinLength: s.passwordMinLength,
    passwordRequireUppercase: s.passwordRequireUppercase,
    passwordRequireNumber: s.passwordRequireNumber,
    passwordRequireSymbol: s.passwordRequireSymbol,
    passwordExpiryDays: s.passwordExpiryDays == null ? '' : String(s.passwordExpiryDays),
  };
}

function loadAuthPolicy(state) {
  state.wf.authPolicy = { loading: true };
  Api.rootApi(`/v1/policies?policyType=${AUTH_METHOD_POLICY_TYPE}`)
    .then((rows) => {
      const active = rows.find((r) => !r.effectiveTo) || rows[0] || null;
      state.wf.authPolicy = {
        policyGroupId: active ? active.policyGroupId : null,
        requiredMethods: active ? active.definition.requiredMethods || [] : [],
        allowedMethods: active ? active.definition.allowedMethods || ['pwd', 'webauthn'] : ['pwd', 'webauthn'],
      };
      doRerender();
    })
    .catch((err) => {
      state.wf.authPolicy = { error: errMsg(err) };
      doRerender();
    });
}

function loadAccessPolicy(state) {
  state.wf.accessPolicy = { loading: true };
  Api.rootApi(`/v1/policies?policyType=${ACCESS_RESTRICTION_POLICY_TYPE}`)
    .then((rows) => {
      const active = rows.find((r) => !r.effectiveTo) || rows[0] || null;
      state.wf.accessPolicy = {
        policyGroupId: active ? active.policyGroupId : null,
        ipAllowlist: active ? (active.definition.ipAllowlist || []).join('\n') : '',
        allowedEmailDomains: active ? (active.definition.allowedEmailDomains || []).join('\n') : '',
      };
      doRerender();
    })
    .catch((err) => {
      state.wf.accessPolicy = { error: errMsg(err) };
      doRerender();
    });
}

function passwordPolicyCard(state) {
  const d = state.scSecurityDraft;
  const saved = emptySecurityDraft(state.wf.settings);
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const saving = state.wf.saving.scSecurity;
  return sec('Password Policy', `
    <div class="grid-2">
      <div class="field"><label>Minimum length</label><input data-wf="sc-sec-field" data-id="passwordMinLength" type="number" min="8" max="128" value="${d.passwordMinLength}" /></div>
      <div class="field"><label>Expires after (days, blank = never)</label><input data-wf="sc-sec-field" data-id="passwordExpiryDays" type="number" min="1" value="${esc(d.passwordExpiryDays)}" /></div>
    </div>
    <div class="field" style="margin-top:10px">
      <label><input type="checkbox" data-wf="sc-sec-toggle" data-id="passwordRequireUppercase" ${d.passwordRequireUppercase ? 'checked' : ''} /> Require an uppercase letter</label><br/>
      <label><input type="checkbox" data-wf="sc-sec-toggle" data-id="passwordRequireNumber" ${d.passwordRequireNumber ? 'checked' : ''} /> Require a number</label><br/>
      <label><input type="checkbox" data-wf="sc-sec-toggle" data-id="passwordRequireSymbol" ${d.passwordRequireSymbol ? 'checked' : ''} /> Require a symbol</label>
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-wf="sc-sec-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-sec-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function authMethodCard(state) {
  const ap = state.wf.authPolicy;
  if (!ap || ap.loading) return sec('Required Authentication Method', `<div class="skel" style="height:40px"></div>`, '');
  if (ap.error) return sec('Required Authentication Method', `<p class="muted">${esc(ap.error)}</p>`, '');
  const d = state.scAuthPolicyDraft || { requiredMethods: [...ap.requiredMethods], allowedMethods: [...ap.allowedMethods] };
  const dirty = JSON.stringify({ requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods }) !==
    JSON.stringify({ requiredMethods: ap.requiredMethods, allowedMethods: ap.allowedMethods });
  const saving = state.wf.saving.scAuthPolicy;
  return sec('Required Authentication Method', `
    <p class="hint" style="margin:0 0 10px">If "Required" is empty, any allowed method is accepted at login. If set, a login must use one of the required methods, even if others are also allowed.</p>
    <table class="data"><thead><tr><th>Method</th><th>Allowed</th><th>Required</th></tr></thead>
    <tbody>${METHODS.map((m) => `<tr>
      <td>${esc(m.label)}</td>
      <td><input type="checkbox" data-wf="sc-authpolicy-toggle" data-scope="allowed" data-id="${m.id}" ${d.allowedMethods.includes(m.id) ? 'checked' : ''} /></td>
      <td><input type="checkbox" data-wf="sc-authpolicy-toggle" data-scope="required" data-id="${m.id}" ${d.requiredMethods.includes(m.id) ? 'checked' : ''} ${d.allowedMethods.includes(m.id) ? '' : 'disabled'} /></td>
    </tr>`).join('')}</tbody></table>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-wf="sc-authpolicy-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-authpolicy-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function accessRestrictionCard(state) {
  const ap = state.wf.accessPolicy;
  if (!ap || ap.loading) return sec('Access Restrictions', `<div class="skel" style="height:40px"></div>`, '');
  if (ap.error) return sec('Access Restrictions', `<p class="muted">${esc(ap.error)}</p>`, '');
  const d = state.scAccessDraft || { ipAllowlist: ap.ipAllowlist, allowedEmailDomains: ap.allowedEmailDomains };
  const dirty = d.ipAllowlist !== ap.ipAllowlist || d.allowedEmailDomains !== ap.allowedEmailDomains;
  const saving = state.wf.saving.scAccess;
  return sec('Access Restrictions', `
    <p class="hint" style="margin:0 0 10px">One entry per line. Leave both blank to allow any IP/domain (no restriction). IP entries are either an exact address or a whole-octet prefix ending in "." (e.g. "10.0.") — not full CIDR notation.</p>
    <div class="grid-2">
      <div class="field"><label>IP allowlist</label><textarea data-wf="sc-access-field" data-id="ipAllowlist" rows="4" placeholder="203.0.113.4&#10;10.0.">${esc(d.ipAllowlist)}</textarea></div>
      <div class="field"><label>Allowed email domains</label><textarea data-wf="sc-access-field" data-id="allowedEmailDomains" rows="4" placeholder="acme-demo.example">${esc(d.allowedEmailDomains)}</textarea></div>
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-wf="sc-access-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-access-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

export function render(state) {
  if (!state.wf.settings) {
    loadSettings(state);
    return pageHead('Security', 'Loading…', '') + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (!state.scSecurityDraft) state.scSecurityDraft = emptySecurityDraft(state.wf.settings);
  if (state.wf.authPolicy === null) loadAuthPolicy(state);
  if (state.wf.accessPolicy === null) loadAccessPolicy(state);
  return `
    ${pageHead('Security', 'Password policy, required authentication method, and access restrictions for this tenant.', '')}
    ${passwordPolicyCard(state)}
    ${authMethodCard(state)}
    ${accessRestrictionCard(state)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-sec-field') {
    state.scSecurityDraft = state.scSecurityDraft || emptySecurityDraft(state.wf.settings);
    state.scSecurityDraft[id] = id === 'passwordMinLength' ? Number(value) : value;
    return true;
  }
  if (act === 'sc-sec-toggle') {
    const el = document.querySelector(`[data-wf="sc-sec-toggle"][data-id="${id}"]`);
    state.scSecurityDraft = state.scSecurityDraft || emptySecurityDraft(state.wf.settings);
    state.scSecurityDraft[id] = !!(el && el.checked);
    return true;
  }
  if (act === 'sc-sec-revert') {
    state.scSecurityDraft = emptySecurityDraft(state.wf.settings);
    return true;
  }
  if (act === 'sc-sec-save') {
    const d = state.scSecurityDraft;
    const passwordExpiryDays = d.passwordExpiryDays === '' ? null : Number(d.passwordExpiryDays);
    state.wf.saving.scSecurity = true;
    doRerender();
    Api.rootApi('/v1/tenant-settings/security', {
      method: 'PUT',
      body: {
        passwordMinLength: d.passwordMinLength,
        passwordRequireUppercase: d.passwordRequireUppercase,
        passwordRequireNumber: d.passwordRequireNumber,
        passwordRequireSymbol: d.passwordRequireSymbol,
        passwordExpiryDays,
      },
    })
      .then((updated) => {
        state.wf.saving.scSecurity = false;
        state.wf.settings = updated;
        state.scSecurityDraft = emptySecurityDraft(updated);
        toast('Password policy saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scSecurity = false;
        // PLATFORM_SECURITY_BASELINE_VIOLATION carries details.violations —
        // one specific reason per failed baseline rule (set by platform_admin
        // under Platform Settings → Security Baseline) — surface those
        // instead of the generic message.
        toast(err.details?.violations?.length ? err.details.violations.join(' ') : errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'sc-authpolicy-toggle') {
    const ap = state.wf.authPolicy;
    const el = document.querySelector(`[data-wf="sc-authpolicy-toggle"][data-scope="${value}"][data-id="${id}"]`);
    state.scAuthPolicyDraft = state.scAuthPolicyDraft || { requiredMethods: [...ap.requiredMethods], allowedMethods: [...ap.allowedMethods] };
    const d = state.scAuthPolicyDraft;
    const checked = !!(el && el.checked);
    const key = value === 'allowed' ? 'allowedMethods' : 'requiredMethods';
    d[key] = checked ? [...new Set([...d[key], id])] : d[key].filter((m) => m !== id);
    if (key === 'allowedMethods' && !checked) {
      // Disallowing a method can never leave it required.
      d.requiredMethods = d.requiredMethods.filter((m) => m !== id);
    }
    return true;
  }
  if (act === 'sc-authpolicy-revert') {
    state.scAuthPolicyDraft = null;
    return true;
  }
  if (act === 'sc-authpolicy-save') {
    const ap = state.wf.authPolicy;
    const d = state.scAuthPolicyDraft;
    if (d.requiredMethods.some((m) => !d.allowedMethods.includes(m))) {
      toast('A required method must also be allowed.');
      return true;
    }
    state.wf.saving.scAuthPolicy = true;
    doRerender();
    Api.rootApi('/v1/policies', {
      method: 'POST',
      body: {
        policyGroupId: ap.policyGroupId || undefined,
        policyType: AUTH_METHOD_POLICY_TYPE,
        definition: { requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods },
      },
    })
      .then((created) => {
        state.wf.saving.scAuthPolicy = false;
        state.wf.authPolicy = { policyGroupId: created.policyGroupId, requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods };
        state.scAuthPolicyDraft = null;
        toast('Required authentication method saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scAuthPolicy = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'sc-access-field') {
    const ap = state.wf.accessPolicy;
    state.scAccessDraft = state.scAccessDraft || { ipAllowlist: ap.ipAllowlist, allowedEmailDomains: ap.allowedEmailDomains };
    state.scAccessDraft[id] = value;
    return true;
  }
  if (act === 'sc-access-revert') {
    state.scAccessDraft = null;
    return true;
  }
  if (act === 'sc-access-save') {
    const ap = state.wf.accessPolicy;
    const d = state.scAccessDraft;
    const ipAllowlist = d.ipAllowlist.split('\n').map((s) => s.trim()).filter(Boolean);
    const allowedEmailDomains = d.allowedEmailDomains.split('\n').map((s) => s.trim()).filter(Boolean);
    state.wf.saving.scAccess = true;
    doRerender();
    Api.rootApi('/v1/policies', {
      method: 'POST',
      body: {
        policyGroupId: ap.policyGroupId || undefined,
        policyType: ACCESS_RESTRICTION_POLICY_TYPE,
        definition: { ipAllowlist, allowedEmailDomains },
      },
    })
      .then((created) => {
        state.wf.saving.scAccess = false;
        state.wf.accessPolicy = { policyGroupId: created.policyGroupId, ipAllowlist: ipAllowlist.join('\n'), allowedEmailDomains: allowedEmailDomains.join('\n') };
        state.scAccessDraft = null;
        toast('Access restrictions saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scAccess = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
