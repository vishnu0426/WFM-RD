/* System Configuration → Email. Real, persisted, secret-masked config
   (PUT /v1/tenant-settings/email). Test Connection genuinely connects to
   the SMTP server via nodemailer's verify() (POST .../email/test-connection)
   and the email channel adapter (SmtpChannelAdapter) now really sends —
   both gap-fixed this round; sms/push/in_app still fall back to the
   logging placeholder since no real provider exists for them. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';
import { loadSettings } from '../shared/loaders.js';

function emptyDraft(s) {
  return {
    smtpHost: s.smtpHost || '',
    smtpPort: s.smtpPort == null ? '' : String(s.smtpPort),
    smtpUsername: s.smtpUsername || '',
    smtpPassword: '',
    smtpFromAddress: s.smtpFromAddress || '',
    smtpUseTls: s.smtpUseTls,
  };
}

export function render(state) {
  if (!state.wf.settings) {
    loadSettings(state);
    return pageHead('Email', 'Loading…', '') + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (!state.scEmailDraft) state.scEmailDraft = emptyDraft(state.wf.settings);
  const d = state.scEmailDraft;
  const saved = emptyDraft(state.wf.settings);
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const saving = state.wf.saving.scEmail;
  const testing = state.wf.saving.scEmailTest;
  const testResult = state.scEmailTestResult;
  return `
    ${pageHead('Email', 'Outbound SMTP configuration for this tenant.', `
      <button class="btn" data-wf="sc-email-test" ${testing ? 'disabled' : ''}>${testing ? 'Testing…' : 'Test Connection'}</button>
      <button class="btn" data-wf="sc-email-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-email-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>`)}
    ${sec('SMTP', `
      ${testResult ? `<p class="${testResult.success ? '' : 'muted'}" style="margin:0 0 10px">${esc(testResult.message)}</p>` : ''}
      <div class="grid-2">
        <div class="field"><label>Host</label><input data-wf="sc-email-field" data-id="smtpHost" placeholder="smtp.example.com" value="${esc(d.smtpHost)}" /></div>
        <div class="field"><label>Port</label><input data-wf="sc-email-field" data-id="smtpPort" type="number" min="1" max="65535" value="${esc(d.smtpPort)}" /></div>
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Username</label><input data-wf="sc-email-field" data-id="smtpUsername" value="${esc(d.smtpUsername)}" /></div>
        <div class="field"><label>Password ${state.wf.settings.smtpPasswordSet ? '<span class="meta">(set — leave blank to keep)</span>' : ''}</label><input data-wf="sc-email-field" data-id="smtpPassword" type="password" placeholder="${state.wf.settings.smtpPasswordSet ? '••••••••' : ''}" value="${esc(d.smtpPassword)}" /></div>
      </div>
      <div class="field" style="margin-top:10px"><label>From address</label><input data-wf="sc-email-field" data-id="smtpFromAddress" placeholder="noreply@example.com" value="${esc(d.smtpFromAddress)}" /></div>
      <div class="field" style="margin-top:10px"><label><input type="checkbox" data-wf="sc-email-tls" ${d.smtpUseTls ? 'checked' : ''} /> Use TLS</label></div>
    `, `<span class="meta">PUT /v1/tenant-settings/email</span>`)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-email-test') {
    state.wf.saving.scEmailTest = true;
    state.scEmailTestResult = null;
    doRerender();
    Api.rootApi('/v1/tenant-settings/email/test-connection', { method: 'POST' })
      .then((result) => {
        state.wf.saving.scEmailTest = false;
        state.scEmailTestResult = result;
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scEmailTest = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === 'sc-email-field') {
    state.scEmailDraft = state.scEmailDraft || emptyDraft(state.wf.settings);
    state.scEmailDraft[id] = value;
    return true;
  }
  if (act === 'sc-email-tls') {
    const el = document.querySelector('[data-wf="sc-email-tls"]');
    state.scEmailDraft = state.scEmailDraft || emptyDraft(state.wf.settings);
    state.scEmailDraft.smtpUseTls = !!(el && el.checked);
    return true;
  }
  if (act === 'sc-email-revert') {
    state.scEmailDraft = emptyDraft(state.wf.settings);
    return true;
  }
  if (act === 'sc-email-save') {
    const d = state.scEmailDraft;
    state.wf.saving.scEmail = true;
    doRerender();
    Api.rootApi('/v1/tenant-settings/email', {
      method: 'PUT',
      body: {
        smtpHost: d.smtpHost.trim() || null,
        smtpPort: d.smtpPort === '' ? null : Number(d.smtpPort),
        smtpUsername: d.smtpUsername.trim() || null,
        smtpPassword: d.smtpPassword.trim() || undefined,
        smtpFromAddress: d.smtpFromAddress.trim() || null,
        smtpUseTls: d.smtpUseTls,
      },
    })
      .then((updated) => {
        state.wf.saving.scEmail = false;
        state.wf.settings = updated;
        state.scEmailDraft = emptyDraft(updated);
        toast('Email settings saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scEmail = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
