/* System Configuration → Notifications. Real tenant-wide default per
   (eventType, channel) — consulted by NotificationService.enqueue only for
   a channel the target user has no explicit personal preference for (an
   explicit user preference always wins). No event-type catalog exists
   anywhere in this platform — only 'skill_expiring' has a real producer
   today; the key is free text, matching the backend's own posture. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../shared/ui.js';

const CHANNELS = ['email', 'sms', 'push', 'in_app'];

function loadRules(state) {
  state.wf.notificationRules = { loading: true };
  Api.rootApi('/v1/notification-rules')
    .then((rows) => {
      state.wf.notificationRules = { rows };
      doRerender();
    })
    .catch((err) => {
      state.wf.notificationRules = { error: errMsg(err) };
      doRerender();
    });
}

export function render(state) {
  if (!state.wf.notificationRules) loadRules(state);
  const list = state.wf.notificationRules;
  const rows = list && list.rows ? list.rows : [];
  const key = (state.scNotifEventType || 'skill_expiring').trim();
  const forKey = (channel) => rows.find((r) => r.eventType === key && r.channel === channel);
  const saving = state.wf.saving.scNotif || {};

  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : `<table class="data"><thead><tr><th>Channel</th><th>Default</th><th></th></tr></thead><tbody>
          ${CHANNELS.map((c) => {
            const rule = forKey(c);
            const enabled = rule ? rule.enabled : false;
            return `<tr>
              <td class="mono">${c}</td>
              <td>${rule ? (enabled ? 'Enabled' : 'Disabled') : '<span class="muted">Not set (off)</span>'}</td>
              <td><button class="btn btn-sm" data-wf="sc-notif-toggle" data-id="${c}" ${saving[c] ? 'disabled' : ''}>${saving[c] ? 'Saving…' : enabled ? 'Disable' : 'Enable'}</button></td>
            </tr>`;
          }).join('')}
        </tbody></table>
        ${rows.length === 0 ? empty('No tenant-wide rules configured yet.', 'A user without their own preference for an event/channel gets nothing until a default is set here.') : ''}`;

  return `
    ${pageHead('Notifications', 'Tenant-wide default per event type and channel — a user’s own preference always overrides this.', '')}
    ${sec('Event type', `
      <div class="toolbar">
        <input data-wf="sc-notif-key" value="${esc(state.scNotifEventType || 'skill_expiring')}" placeholder="event type" style="max-width:320px" />
      </div>
      <p class="hint" style="margin-top:6px">Only <code>skill_expiring</code> has a real producer in this platform today — the key is free text, same as the backend.</p>
    `, '')}
    ${sec('Channel defaults', body)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-notif-key') {
    state.scNotifEventType = value;
    return true;
  }
  if (act === 'sc-notif-toggle') {
    const key = (state.scNotifEventType || 'skill_expiring').trim();
    const rows = (state.wf.notificationRules && state.wf.notificationRules.rows) || [];
    const rule = rows.find((r) => r.eventType === key && r.channel === id);
    const nextEnabled = !(rule ? rule.enabled : false);
    state.wf.saving.scNotif = state.wf.saving.scNotif || {};
    state.wf.saving.scNotif[id] = true;
    doRerender();
    Api.rootApi(`/v1/notification-rules/${encodeURIComponent(key)}/${id}`, { method: 'PUT', body: { enabled: nextEnabled } })
      .then(() => {
        state.wf.saving.scNotif[id] = false;
        state.wf.notificationRules = null;
        toast('Notification rule saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scNotif[id] = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
