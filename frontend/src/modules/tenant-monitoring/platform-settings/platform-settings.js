/* Platform > Platform Settings — genuinely platform-wide config (no tenant
   picker, unlike System Configuration): global feature flag defaults,
   platform-wide SMTP fallback, and a security baseline every tenant's own
   Security policy must respect. Backed by PlatformSettingsController
   (src/modules/platform-settings/rest/platform-settings.controller.ts,
   GET/PUT /v1/platform-settings/*).

   Same field shapes as the per-tenant equivalents this mirrors — Feature
   Flag Defaults ~ feature-flags.js's table, SMTP ~ all-tenants.js's
   emailConfigPanel, Security Baseline ~ all-tenants.js's
   tcPasswordPolicyCard, restated as floors/ceilings rather than one
   tenant's values — but reads/writes the platform-wide row/table, not any
   one tenant's. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../../identity-org/shared/ui.js';
import * as TenantMonitoringApi from '../api.js';

const DEFAULT_FLAG_KEY = 'bulk_import_destructive';

function loadFlagDefaults(state) {
  state.wf.platformFlagDefaults = { loading: true };
  doRerender();
  TenantMonitoringApi.getPlatformFeatureFlagDefaults()
    .then((rows) => { state.wf.platformFlagDefaults = { rows }; doRerender(); })
    .catch((err) => { state.wf.platformFlagDefaults = { error: errMsg(err) }; doRerender(); });
}

function loadSmtp(state) {
  state.wf.platformSmtp = { loading: true };
  doRerender();
  TenantMonitoringApi.getPlatformSmtpSettings()
    .then((settings) => { state.wf.platformSmtp = { settings }; doRerender(); })
    .catch((err) => { state.wf.platformSmtp = { error: errMsg(err) }; doRerender(); });
}

function loadBaseline(state) {
  state.wf.platformBaseline = { loading: true };
  doRerender();
  TenantMonitoringApi.getPlatformSecurityBaseline()
    .then((settings) => { state.wf.platformBaseline = { settings }; doRerender(); })
    .catch((err) => { state.wf.platformBaseline = { error: errMsg(err) }; doRerender(); });
}

function emptySmtpDraft(s) {
  return {
    smtpHost: s.smtpHost || '',
    smtpPort: s.smtpPort == null ? '' : String(s.smtpPort),
    smtpUsername: s.smtpUsername || '',
    smtpPassword: '',
    smtpFromAddress: s.smtpFromAddress || '',
    smtpUseTls: s.smtpUseTls,
  };
}

function emptyBaselineDraft(s) {
  return {
    passwordMinLengthFloor: s.passwordMinLengthFloor == null ? '' : String(s.passwordMinLengthFloor),
    passwordRequireUppercase: s.passwordRequireUppercase,
    passwordRequireNumber: s.passwordRequireNumber,
    passwordRequireSymbol: s.passwordRequireSymbol,
    passwordExpiryDaysCeiling: s.passwordExpiryDaysCeiling == null ? '' : String(s.passwordExpiryDaysCeiling),
    sessionTimeoutCeilingMinutes: s.sessionTimeoutCeilingMinutes == null ? '' : String(s.sessionTimeoutCeilingMinutes),
    mfaRequired: s.mfaRequired,
  };
}

function featureFlagDefaultsCard(state) {
  const cache = state.wf.platformFlagDefaults;
  if (!cache || cache.loading) return sec('Feature Flag Defaults', `<div class="skel" style="height:60px"></div>`, '');
  if (cache.error) return sec('Feature Flag Defaults', `<p class="muted">${esc(cache.error)}</p>`, '');
  const key = (state.pfdNewKey || '').trim();
  const saving = state.wf.saving?.pfd || {};
  const rows = cache.rows || [];
  const table = rows.length
    ? `<table class="data"><thead><tr><th>Flag key</th><th>Default</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td class="mono">${esc(r.flagKey)}</td>
          <td>${r.enabled ? 'Enabled' : 'Disabled'}</td>
          <td><button class="btn btn-sm" data-act="pfd-toggle" data-id="${esc(r.flagKey)}" ${saving[r.flagKey] ? 'disabled' : ''}>${saving[r.flagKey] ? 'Saving…' : r.enabled ? 'Disable' : 'Enable'}</button></td>
        </tr>`).join('')}
      </tbody></table>`
    : `<p class="muted">No platform-wide defaults set yet.</p>`;
  return sec('Feature Flag Defaults', `
    <p class="hint" style="margin:0 0 10px">Applies only when a tenant has no explicit override of its own (Platform &gt; Feature Flags) — an explicit per-tenant value, even "disabled", always wins over this default.</p>
    <div class="toolbar" style="margin-bottom:10px">
      <input data-wf="pfd-new-key" data-id="_" value="${esc(state.pfdNewKey || '')}" placeholder="flag key, e.g. ${DEFAULT_FLAG_KEY}" style="max-width:320px" />
      <button class="btn" data-act="pfd-enable-new" ${key ? '' : 'disabled'}>Add / Enable</button>
    </div>
    ${table}
  `);
}

function smtpCard(state, cache) {
  const s = cache.settings;
  if (!state.platformSmtpDraft) state.platformSmtpDraft = emptySmtpDraft(s);
  const d = state.platformSmtpDraft;
  const dirty = JSON.stringify(d) !== JSON.stringify(emptySmtpDraft(s));
  const saving = state.wf.saving?.platformSmtp;
  const testing = state.wf.saving?.platformSmtpTest;
  const testResult = state.platformSmtpTestResult;
  return sec('Default SMTP', `
    <p class="hint" style="margin:0 0 10px">Used only when a tenant has no complete SMTP configuration of its own (System Configuration → Email) — a tenant with its own host/port/from-address always uses that instead.</p>
    ${testResult ? `<p style="margin:0 0 10px">${esc(testResult.message)}</p>` : ''}
    <div class="grid-2">
      <div class="field"><label>Host</label><input data-wf="psmtp-field" data-id="smtpHost" placeholder="smtp.example.com" value="${esc(d.smtpHost)}" /></div>
      <div class="field"><label>Port</label><input data-wf="psmtp-field" data-id="smtpPort" type="number" min="1" max="65535" value="${esc(d.smtpPort)}" /></div>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Username</label><input data-wf="psmtp-field" data-id="smtpUsername" value="${esc(d.smtpUsername)}" /></div>
      <div class="field"><label>Password ${s.smtpPasswordSet ? '<span class="meta">(set — leave blank to keep)</span>' : ''}</label><input data-wf="psmtp-field" data-id="smtpPassword" type="password" placeholder="${s.smtpPasswordSet ? '••••••••' : ''}" value="${esc(d.smtpPassword)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>From address</label><input data-wf="psmtp-field" data-id="smtpFromAddress" placeholder="noreply@example.com" value="${esc(d.smtpFromAddress)}" /></div>
    <div class="field" style="margin-top:10px"><label><input type="checkbox" data-wf="psmtp-tls" data-id="_" ${d.smtpUseTls ? 'checked' : ''} /> Use TLS</label></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="psmtp-test" ${testing ? 'disabled' : ''}>${testing ? 'Testing…' : 'Test Connection'}</button>
      <button class="btn" data-act="psmtp-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="psmtp-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function baselineCard(state, cache) {
  const s = cache.settings;
  if (!state.platformBaselineDraft) state.platformBaselineDraft = emptyBaselineDraft(s);
  const d = state.platformBaselineDraft;
  const dirty = JSON.stringify(d) !== JSON.stringify(emptyBaselineDraft(s));
  const saving = state.wf.saving?.platformBaseline;
  return sec('Security Baseline', `
    <p class="hint" style="margin:0 0 10px">A floor/ceiling every tenant's own Security policy must respect — checked when a tenant (or a platform admin acting on their behalf) saves Security. Blank/unchecked = no restriction from the platform.</p>
    <div class="grid-2">
      <div class="field"><label>Minimum password length (floor)</label><input data-wf="psec-field" data-id="passwordMinLengthFloor" type="number" min="8" max="128" placeholder="no floor" value="${esc(d.passwordMinLengthFloor)}" /></div>
      <div class="field"><label>Password expiry (days, ceiling)</label><input data-wf="psec-field" data-id="passwordExpiryDaysCeiling" type="number" min="1" placeholder="no ceiling" value="${esc(d.passwordExpiryDaysCeiling)}" /></div>
    </div>
    <div class="field" style="margin-top:10px">
      <label><input type="checkbox" data-wf="psec-toggle" data-id="passwordRequireUppercase" ${d.passwordRequireUppercase ? 'checked' : ''} /> Every tenant must require an uppercase letter</label><br/>
      <label><input type="checkbox" data-wf="psec-toggle" data-id="passwordRequireNumber" ${d.passwordRequireNumber ? 'checked' : ''} /> Every tenant must require a number</label><br/>
      <label><input type="checkbox" data-wf="psec-toggle" data-id="passwordRequireSymbol" ${d.passwordRequireSymbol ? 'checked' : ''} /> Every tenant must require a symbol</label>
    </div>
    <div class="field" style="margin-top:10px;max-width:calc(50% - 6px)"><label>Session timeout (minutes, ceiling)</label><input data-wf="psec-field" data-id="sessionTimeoutCeilingMinutes" type="number" min="5" max="1440" placeholder="no ceiling" value="${esc(d.sessionTimeoutCeilingMinutes)}" /></div>
    <div class="field" style="margin-top:10px"><label><input type="checkbox" data-wf="psec-toggle" data-id="mfaRequired" ${d.mfaRequired ? 'checked' : ''} /> Every tenant must require MFA</label></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="psec-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="psec-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

export function render(state) {
  if (state.wf.platformFlagDefaults === undefined) loadFlagDefaults(state);
  if (state.wf.platformSmtp === undefined) loadSmtp(state);
  if (state.wf.platformBaseline === undefined) loadBaseline(state);

  const smtpCache = state.wf.platformSmtp;
  const baselineCache = state.wf.platformBaseline;

  return `
    ${pageHead('Platform Settings', 'Platform-wide defaults and constraints that apply across every tenant — not any one tenant’s own configuration.', '')}
    ${featureFlagDefaultsCard(state)}
    ${!smtpCache || smtpCache.loading ? sec('Default SMTP', `<div class="skel" style="height:60px"></div>`, '') : smtpCache.error ? sec('Default SMTP', `<p class="muted">${esc(smtpCache.error)}</p>`, '') : smtpCard(state, smtpCache)}
    ${!baselineCache || baselineCache.loading ? sec('Security Baseline', `<div class="skel" style="height:60px"></div>`, '') : baselineCache.error ? sec('Security Baseline', `<p class="muted">${esc(baselineCache.error)}</p>`, '') : baselineCard(state, baselineCache)}
  `;
}

export function handle(state, act, id, value) {
  if (act === 'pfd-new-key') {
    state.pfdNewKey = value;
    return true;
  }
  if (act === 'pfd-enable-new' || act === 'pfd-toggle') {
    const flagKey = act === 'pfd-enable-new' ? (state.pfdNewKey || '').trim() : id;
    if (!flagKey) return true;
    const rows = state.wf.platformFlagDefaults?.rows || [];
    const existing = rows.find((r) => r.flagKey === flagKey);
    const nextEnabled = act === 'pfd-enable-new' ? true : !existing.enabled;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.pfd = state.wf.saving.pfd || {};
    state.wf.saving.pfd[flagKey] = true;
    doRerender();
    TenantMonitoringApi.setPlatformFeatureFlagDefault(flagKey, nextEnabled)
      .then(() => {
        state.wf.saving.pfd[flagKey] = false;
        if (act === 'pfd-enable-new') state.pfdNewKey = '';
        toast('Feature flag default saved.');
        loadFlagDefaults(state);
      })
      .catch((err) => {
        state.wf.saving.pfd[flagKey] = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'psmtp-field') {
    state.platformSmtpDraft = state.platformSmtpDraft || emptySmtpDraft(state.wf.platformSmtp.settings);
    state.platformSmtpDraft[id] = value;
    return true;
  }
  if (act === 'psmtp-tls') {
    const el = document.querySelector('[data-wf="psmtp-tls"]');
    state.platformSmtpDraft = state.platformSmtpDraft || emptySmtpDraft(state.wf.platformSmtp.settings);
    state.platformSmtpDraft.smtpUseTls = !!(el && el.checked);
    return true;
  }
  if (act === 'psmtp-revert') {
    state.platformSmtpDraft = null;
    return true;
  }
  if (act === 'psmtp-test') {
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.platformSmtpTest = true;
    state.platformSmtpTestResult = null;
    doRerender();
    TenantMonitoringApi.testPlatformSmtpConnection()
      .then((result) => {
        state.wf.saving.platformSmtpTest = false;
        state.platformSmtpTestResult = result;
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.platformSmtpTest = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === 'psmtp-save') {
    const d = state.platformSmtpDraft;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.platformSmtp = true;
    doRerender();
    TenantMonitoringApi.updatePlatformSmtpSettings({
      smtpHost: (d.smtpHost || '').trim() || null,
      smtpPort: d.smtpPort === '' ? null : Number(d.smtpPort),
      smtpUsername: (d.smtpUsername || '').trim() || null,
      smtpPassword: (d.smtpPassword || '').trim() || undefined,
      smtpFromAddress: (d.smtpFromAddress || '').trim() || null,
      smtpUseTls: d.smtpUseTls,
    })
      .then((settings) => {
        state.wf.saving.platformSmtp = false;
        state.wf.platformSmtp = { settings };
        state.platformSmtpDraft = null;
        toast('Platform SMTP defaults saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.platformSmtp = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'psec-field') {
    state.platformBaselineDraft = state.platformBaselineDraft || emptyBaselineDraft(state.wf.platformBaseline.settings);
    state.platformBaselineDraft[id] = value;
    return true;
  }
  if (act === 'psec-toggle') {
    const el = document.querySelector(`[data-wf="psec-toggle"][data-id="${id}"]`);
    state.platformBaselineDraft = state.platformBaselineDraft || emptyBaselineDraft(state.wf.platformBaseline.settings);
    state.platformBaselineDraft[id] = !!(el && el.checked);
    return true;
  }
  if (act === 'psec-revert') {
    state.platformBaselineDraft = null;
    return true;
  }
  if (act === 'psec-save') {
    const d = state.platformBaselineDraft;
    const toNum = (s) => (s === '' ? null : Number(s));
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.platformBaseline = true;
    doRerender();
    TenantMonitoringApi.updatePlatformSecurityBaseline({
      passwordMinLengthFloor: toNum(d.passwordMinLengthFloor),
      passwordRequireUppercase: d.passwordRequireUppercase,
      passwordRequireNumber: d.passwordRequireNumber,
      passwordRequireSymbol: d.passwordRequireSymbol,
      passwordExpiryDaysCeiling: toNum(d.passwordExpiryDaysCeiling),
      sessionTimeoutCeilingMinutes: toNum(d.sessionTimeoutCeilingMinutes),
      mfaRequired: d.mfaRequired,
    })
      .then((settings) => {
        state.wf.saving.platformBaseline = false;
        state.wf.platformBaseline = { settings };
        state.platformBaselineDraft = null;
        toast('Security baseline saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.platformBaseline = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  return false;
}
