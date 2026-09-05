/* System Configuration → Feature Configuration. This tenant's own flags via
   root's real GraphQL (featureFlag/setFeatureFlag). No "list all my flags"
   query exists in the backend — same key-lookup-only shape as the Platform
   Admin cross-tenant Feature Flags screen built earlier this session, just
   single-tenant here (no tenant picker). Only bulk_import_destructive is in
   real use today; the key itself is free text with no enum/catalog. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';

const QUERY = `query($flagKey: String!) { featureFlag(flagKey: $flagKey) { flagKey enabled } }`;
const MUTATION = `mutation($flagKey: String!, $enabled: Boolean!) { setFeatureFlag(flagKey: $flagKey, enabled: $enabled) { flagKey enabled } }`;

function loadFlag(state, flagKey) {
  state.wf.flagStatus = { loading: true };
  Api.gqlFetch(QUERY, { flagKey })
    .then((data) => {
      state.wf.flagStatus = { flagKey, enabled: data.featureFlag.enabled };
      doRerender();
    })
    .catch((err) => {
      state.wf.flagStatus = { error: errMsg(err) };
      doRerender();
    });
}

export function render(state) {
  const fs = state.wf.flagStatus;
  return `
    ${pageHead('Feature Configuration', 'Look up and toggle a feature flag for this tenant by key.', '')}
    ${sec('Flag lookup', `
      <div class="toolbar">
        <input data-wf="sc-flag-key" value="${esc(state.scFlagKey)}" placeholder="flag key" style="max-width:320px" />
        <button class="btn" data-wf="sc-flag-load">Check</button>
      </div>
      ${!fs ? '' : fs.loading ? `<div class="skel" style="height:24px;margin-top:10px"></div>` : fs.error ? `<p class="muted" style="margin-top:10px">${esc(fs.error)}</p>` : `
        <div class="actions" style="margin-top:14px">
          <b>${esc(fs.flagKey)}</b> is currently <b>${fs.enabled ? 'enabled' : 'disabled'}</b> for your tenant.
          <button class="btn btn-primary" data-wf="sc-flag-toggle" data-id="${fs.enabled ? 'false' : 'true'}" ${state.wf.saving.scFlag ? 'disabled' : ''}>${state.wf.saving.scFlag ? 'Saving…' : fs.enabled ? 'Disable' : 'Enable'}</button>
        </div>`}
    `)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-flag-key') {
    state.scFlagKey = value;
    return true;
  }
  if (act === 'sc-flag-load') {
    if (!state.scFlagKey.trim()) {
      toast('Enter a flag key.');
      return true;
    }
    loadFlag(state, state.scFlagKey.trim());
    return true;
  }
  if (act === 'sc-flag-toggle') {
    const enabled = id === 'true';
    state.wf.saving.scFlag = true;
    doRerender();
    Api.gqlFetch(MUTATION, { flagKey: state.wf.flagStatus.flagKey, enabled })
      .then((data) => {
        state.wf.saving.scFlag = false;
        state.wf.flagStatus = { flagKey: data.setFeatureFlag.flagKey, enabled: data.setFeatureFlag.enabled };
        toast('Feature flag updated.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scFlag = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
