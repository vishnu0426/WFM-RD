/* Workforce Analytics > Queue Analytics — read-only dashboard assembling
   existing telemetry for one org unit ("queue"): queue profile, service
   level target, forecast accuracy, latest backlog reading, and campaign
   membership. Wired to forecasting-service. No real-time occupancy/AHT/
   abandon-rate here — the backend deliberately doesn't invent live
   telephony signals it has no source for (see queue_analytics.py's own
   doc comment); this screen only shows what that endpoint actually
   returns. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { pageHead, sec, empty, fmtDt } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);
const pct = (fraction) => (fraction == null ? "—" : `${(Number(fraction) * 100).toFixed(1)}%`);

function backlogBadge(status) {
  const map = { ok: ["badge-ok", "OK"], warning: ["badge-warn", "Warning"], critical: ["badge-danger", "Critical"], unknown: ["badge-sys", "No template"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

function campaignBadge(status) {
  const map = { draft: ["badge-sys", "Draft"], active: ["badge-ok", "Active"], paused: ["badge-warn", "Paused"], completed: ["badge-off", "Completed"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

async function loadAnalytics(state, orgUnitId) {
  state.wf.queueAnalytics = state.wf.queueAnalytics || {};
  try {
    state.wf.queueAnalytics[orgUnitId] = await ForecastingApi.getQueueAnalytics(orgUnitId);
  } catch (err) {
    state.wf.queueAnalytics[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.qaOu === undefined && orgUnits.length) state.qaOu = orgUnits[0].id;

  if (!orgUnits.length) {
    return `${pageHead("Queue Analytics", "Read-only rollup of forecast accuracy, SLA targets, backlog, and campaigns for one queue — wired to forecasting-service.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  state.wf.queueAnalytics = state.wf.queueAnalytics || {};
  const a = state.wf.queueAnalytics[state.qaOu];
  if (a === undefined) loadAnalytics(state, state.qaOu);

  let body = `<div class="skel" style="height:24px"></div>`;
  if (a && a.error) body = `<p class="muted">${esc(a.error)}</p>`;
  else if (a) {
    const qp = a.queueProfile;
    const slt = a.serviceLevelTarget;
    const acc = a.accuracy;
    body = `
      ${sec("Queue profile", !qp ? `<p class="muted">Not configured for this org unit.</p>` : `<dl class="kv">
        <dt>Industry</dt><dd>${esc(qp.industry ?? "—")}</dd>
        <dt>Queue type</dt><dd>${esc(qp.queueType ?? "—")}</dd>
        <dt>Expected volume band</dt><dd>${esc(qp.expectedVolumeBand ?? "—")}</dd>
        <dt>Timezone bucket</dt><dd>${esc(qp.timezoneBucket ?? "—")}</dd>
      </dl>`)}
      ${sec("Service level target", `<dl class="kv">
        <dt>Target service level</dt><dd>${pct(slt.targetServiceLevel)}</dd>
        <dt>Target answer time</dt><dd>${slt.targetAnswerTimeSeconds}s</dd>
        <dt>Max occupancy</dt><dd>${pct(slt.maxOccupancy)}</dd>
      </dl>${slt.isDefault ? `<p class="hint">Platform default — not configured for this org unit. See Forecasting &gt; Goals &amp; Requirements.</p>` : ""}`)}
      ${sec("Forecast accuracy", `<dl class="kv">
        <dt>Accuracy points</dt><dd>${acc.pointCount}</dd>
        <dt>Avg MAPE</dt><dd>${acc.avgMape != null ? `${Number(acc.avgMape).toFixed(1)}%` : "—"}</dd>
        <dt>Latest evaluated</dt><dd>${acc.latestEvaluatedAt ? fmtDt(acc.latestEvaluatedAt) : "—"}</dd>
        <dt>Latest actual vs predicted volume</dt><dd>${acc.latestActualVolume != null ? `${acc.latestActualVolume} vs ${acc.latestPredictedVolume ?? "—"}` : "—"}</dd>
      </dl>`)}
      ${sec("Latest backlog", !a.latestBacklog ? `<p class="muted">No backlog snapshot recorded yet. See Forecasting &gt; Backlog Age.</p>` : `<dl class="kv">
        <dt>Item count</dt><dd>${a.latestBacklog.itemCount}</dd>
        <dt>Oldest item age</dt><dd>${a.latestBacklog.oldestItemAgeMinutes} min</dd>
        <dt>Recorded</dt><dd>${fmtDt(a.latestBacklog.recordedAt)}</dd>
        <dt>Status</dt><dd>${backlogBadge(a.latestBacklog.status)}</dd>
      </dl>`)}
      ${sec("Campaigns", !a.campaigns.length ? `<p class="muted">Not assigned to any campaign's queues. See Campaigns &gt; Queues.</p>` : a.campaigns.map((c) => `<div class="cov"><div><b>${esc(c.name)}</b></div><div>${campaignBadge(c.status)}</div></div>`).join(""))}
    `;
  }

  return `
    ${pageHead("Queue Analytics", "Read-only rollup of forecast accuracy, SLA targets, backlog, and campaigns for one queue — wired to forecasting-service.", "")}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Org unit (queue)</label>
      <select data-wf="qa-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.qaOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
    </div>
    ${body}`;
}

export function handle(state, act, id, value) {
  if (act === "qa-ou") { state.qaOu = value; return true; }
  return false;
}
