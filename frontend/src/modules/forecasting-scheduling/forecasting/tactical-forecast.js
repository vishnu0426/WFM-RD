/* Forecasting > Tactical Forecast — submit/poll a forecast job, then show
   its per-interval predictions. Wired to forecasting-service.

   Submission has four real backend outcomes (see job_service.py's own doc
   comment): insufficient data with no cold-start donors (422, surfaced as
   an error toast), a cold-start estimate (completed immediately), a fitted
   model's inference (completed immediately), or `status: queued` when the
   gate passes but no model has been trained yet — nothing auto-trains one,
   so this screen offers a "Train models now" action that calls the real
   /retrain endpoint (can take up to ~2 minutes) rather than leaving the
   user stuck. Recent runs are listed from the real history endpoint
   (GET /v1/forecasting/jobs?org_unit_id=…) — previously there was no way
   to see past runs, only look one up by a job id you already had. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);
const num = (v, digits = 1) => (v == null ? "—" : Number(v).toFixed(digits));

function statusBadge(s) {
  const map = { completed: ["badge-ok", "Completed"], queued: ["badge-warn", "Queued — no trained model yet"] };
  const [c, l] = map[s] || ["badge-sys", s];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

async function loadDataPoints(state, jobId) {
  state.wf.forecastDataPoints = state.wf.forecastDataPoints || {};
  try {
    state.wf.forecastDataPoints[jobId] = await ForecastingApi.getForecastJobDataPoints(jobId);
  } catch (err) {
    state.wf.forecastDataPoints[jobId] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadHistory(state, orgUnitId) {
  state.wf.forecastJobHistory = state.wf.forecastJobHistory || {};
  try {
    state.wf.forecastJobHistory[orgUnitId] = await ForecastingApi.listForecastJobs(orgUnitId);
  } catch (err) {
    state.wf.forecastJobHistory[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.tfOu === undefined && orgUnits.length) state.tfOu = orgUnits[0].id;

  if (!orgUnits.length) {
    return `${pageHead("Tactical Forecast", "Submit a forecast run and inspect its predicted intervals — wired to forecasting-service.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  state.wf.forecastJobs = state.wf.forecastJobs || {};
  const job = state.wf.forecastJobs[state.tfOu];

  const today = new Date().toISOString().slice(0, 10);
  const weekOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  let resultBody = "";
  if (job) {
    let dataPointsSection = "";
    if (job.status === "completed") {
      state.wf.forecastDataPoints = state.wf.forecastDataPoints || {};
      const points = state.wf.forecastDataPoints[job.id];
      if (points === undefined) loadDataPoints(state, job.id);
      dataPointsSection = !points
        ? `<div class="skel" style="height:24px"></div>`
        : !isOk(points) ? `<p class="muted">${esc(points.error)}</p>`
        : `<table class="data"><thead><tr><th>Interval</th><th>Volume</th><th>AHT (s)</th><th>Shrinkage %</th><th>Confidence</th><th>Req. headcount</th></tr></thead><tbody>${
            points.map((p) => `<tr>
              <td class="mono">${new Date(p.intervalStart).toLocaleString()}</td>
              <td class="mono">${num(p.predictedVolume, 0)}</td>
              <td class="mono">${num(p.predictedAhtSeconds, 0)}</td>
              <td class="mono">${p.predictedShrinkagePct != null ? num(p.predictedShrinkagePct * 100) : "—"}</td>
              <td class="mono muted">${p.confidenceLower != null ? `${num(p.confidenceLower, 0)}–${num(p.confidenceUpper, 0)}` : "—"}</td>
              <td class="mono">${num(p.requiredHeadcount, 1)}</td>
            </tr>`).join("") || `<tr><td colspan="6" class="muted">Run completed but returned no data points.</td></tr>`
          }</tbody></table>`;
    } else if (job.status === "queued") {
      dataPointsSection = `<p class="muted">This org unit has no active forecast model yet, so the run can't produce predictions on its own.</p>
        <button class="btn" data-wf="tf-retrain" ${state.wf.retraining ? "disabled" : ""}>${state.wf.retraining ? "Training… this can take up to 2 minutes" : "Train models now"}</button>`;
    }
    resultBody = `<div style="margin-bottom:10px">${statusBadge(job.status)}</div>${dataPointsSection}`;
  } else {
    resultBody = `<p class="muted">No run submitted yet this session.</p>`;
  }

  state.wf.forecastJobHistory = state.wf.forecastJobHistory || {};
  const history = state.wf.forecastJobHistory[state.tfOu];
  if (history === undefined) loadHistory(state, state.tfOu);
  const historyBody = !history
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(history) ? `<p class="muted">${esc(history.error)}</p>`
    : `<table class="data"><thead><tr><th>Requested</th><th>Range</th><th>Interval</th><th>Status</th><th></th></tr></thead><tbody>${
        history.map((h) => `<tr>
          <td class="muted">${new Date(h.requestedAt).toLocaleString()}</td>
          <td class="mono">${h.dateRange.start} – ${h.dateRange.end}</td>
          <td class="mono">${h.intervalMinutes}m</td>
          <td>${statusBadge(h.status)}</td>
          <td><button class="btn btn-sm" data-wf="tf-load-run" data-id="${h.id}">View</button></td>
        </tr>`).join("") || `<tr><td colspan="5" class="muted">No runs recorded yet for this org unit.</td></tr>`
      }</tbody></table>`;

  return `
    ${pageHead("Tactical Forecast", "Submit a forecast run and inspect its predicted intervals — wired to forecasting-service.", "")}
    ${sec("Submit run", `
      <div class="grid-2">
        <div class="field full"><label>Org unit</label><select id="tf-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.tfOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
        <div class="field"><label>From</label><input id="tf-start" type="date" value="${today}" /></div>
        <div class="field"><label>To</label><input id="tf-end" type="date" value="${weekOut}" /></div>
        <div class="field"><label>Interval</label><select id="tf-interval"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">60 minutes</option></select></div>
      </div>
      <div class="actions" style="margin-top:10px"><button class="btn btn-primary" data-wf="tf-submit" ${state.wf.saving.tf ? "disabled" : ""}>${state.wf.saving.tf ? "Submitting…" : "Submit run"}</button></div>
    `)}
    ${sec("Recent runs", historyBody)}
    ${sec("Result", resultBody)}`;
}

export function handle(state, act) {
  if (act === "tf-submit") {
    const orgUnitId = $("#tf-ou")?.value;
    const start = $("#tf-start")?.value;
    const end = $("#tf-end")?.value;
    const intervalMinutes = Number($("#tf-interval")?.value || 30);
    if (!start || !end) { toast("Both dates are required."); return true; }
    if (end < start) { toast("End date must not be before start date."); return true; }
    state.tfOu = orgUnitId;
    state.wf.saving.tf = true;
    doRerender();
    ForecastingApi.submitForecastJob({ orgUnitId, dateRange: { start, end }, intervalMinutes })
      .then((resp) => {
        state.wf.saving.tf = false;
        state.wf.forecastJobs = state.wf.forecastJobs || {};
        state.wf.forecastJobs[orgUnitId] = { id: resp.jobId, status: resp.status };
        if (state.wf.forecastDataPoints) delete state.wf.forecastDataPoints[resp.jobId];
        if (state.wf.forecastJobHistory) delete state.wf.forecastJobHistory[orgUnitId];
        toast(resp.status === "completed" ? "Forecast run completed." : "Forecast run queued — no trained model yet for this org unit.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tf = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "tf-load-run") {
    const history = state.wf.forecastJobHistory && state.wf.forecastJobHistory[state.tfOu];
    const run = isOk(history) ? history.find((h) => h.id === id) : null;
    if (!run) return true;
    state.wf.forecastJobs = state.wf.forecastJobs || {};
    state.wf.forecastJobs[state.tfOu] = { id: run.id, status: run.status };
    if (state.wf.forecastDataPoints) delete state.wf.forecastDataPoints[run.id];
    doRerender();
    return true;
  }

  if (act === "tf-retrain") {
    state.wf.retraining = true;
    doRerender();
    ForecastingApi.retrainModels(state.tfOu)
      .then(() => {
        state.wf.retraining = false;
        toast("Training complete — submit the run again.");
        doRerender();
      })
      .catch((err) => {
        state.wf.retraining = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
