/* Campaigns > Settings / Campaigns > Queues — wired to forecasting-service
   (:8000). A "Queue" here is a CampaignQueue row (a campaign <-> org-unit
   assignment), not the separate CcQueue/ACD-queue model. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);
const WEEK_DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const PERIODS = ["WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"];

async function loadCampaigns(state) {
  if (state.wf.campaigns) return state.wf.campaigns;
  try {
    state.wf.campaigns = await ForecastingApi.listCampaigns();
  } catch (err) {
    state.wf.campaigns = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.campaigns;
}

async function loadCampaignQueues(state, campaignId) {
  state.wf.campaignQueues = state.wf.campaignQueues || {};
  if (state.wf.campaignQueues[campaignId]) return state.wf.campaignQueues[campaignId];
  try {
    state.wf.campaignQueues[campaignId] = await ForecastingApi.listCampaignQueues(campaignId);
  } catch (err) {
    state.wf.campaignQueues[campaignId] = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.campaignQueues[campaignId];
}

const fmtDate = (d) => d || "—";
const fmtTimeOfDay = (t) => (t ? t.slice(0, 5) : "—");

function campaignBadge(status) {
  const map = { draft: ["badge-sys", "Draft"], active: ["badge-ok", "Active"], paused: ["badge-warn", "Paused"], completed: ["badge-off", "Completed"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

/* ---------- Settings ---------- */

function renderSettings(state) {
  if (!state.wf.campaigns) loadCampaigns(state);
  const campaigns = state.wf.campaigns;
  if (state.campaignId === undefined && isOk(campaigns) && campaigns.length) state.campaignId = campaigns[0].id;
  const c = isOk(campaigns) ? campaigns.find((x) => x.id === state.campaignId) : undefined;

  const body = `
    <div class="split">
      <div class="split-l">${
        !campaigns ? `<div class="skel" style="height:24px"></div>`
        : !isOk(campaigns) ? `<p class="muted" style="padding:12px">${esc(campaigns.error)}</p>`
        : campaigns.map((x) => `<button class="${x.id === state.campaignId ? "on" : ""}" data-wf="pick-campaign" data-id="${x.id}"><b>${esc(x.name)}</b><div class="muted">${campaignBadge(x.status)}</div></button>`).join("") || empty("No campaigns yet.", "Create one to get started.")
      }</div>
      <div class="split-r">
        ${!c ? empty("Select a campaign.") : `
        ${sec("Settings", `<dl class="kv">
          <dt>Name</dt><dd>${esc(c.name)}</dd>
          <dt>Description</dt><dd>${c.description ? esc(c.description) : "—"}</dd>
          <dt>Status</dt><dd>${campaignBadge(c.status)}</dd>
          <dt>Start date</dt><dd class="mono">${fmtDate(c.startDate)}</dd>
          <dt>End date</dt><dd class="mono">${fmtDate(c.endDate)}</dd>
          <dt>Time zone</dt><dd>${c.timeZone ? esc(c.timeZone) : "—"}</dd>
          <dt>Week start day</dt><dd>${c.weekStartDay ? esc(c.weekStartDay) : "—"}</dd>
          <dt>Day boundary</dt><dd class="mono">${fmtTimeOfDay(c.dayBoundary)}</dd>
          <dt>Distributed campaign</dt><dd>${c.isDistributedCampaign ? "Yes" : "No"}</dd>
          <dt>Scheduling period</dt><dd>${c.schedulingPeriod ? esc(c.schedulingPeriod) : "—"}</dd>
        </dl>`)}
        <div class="actions">
          <button class="btn" data-wf="edit-campaign" data-id="${c.id}">Edit</button>
          <button class="btn" data-wf="delete-campaign" data-id="${c.id}">Delete</button>
        </div>`}
      </div>
    </div>`;

  return `
    ${pageHead("Settings", "Campaigns — wired to forecasting-service.", `<button class="btn btn-primary" data-wf="open-campaign">+ New campaign</button>`)}
    ${body}`;
}

/* ---------- Queues ---------- */

function renderQueues(state) {
  if (!state.wf.campaigns) loadCampaigns(state);
  const campaigns = state.wf.campaigns;
  if (state.campaignId === undefined && isOk(campaigns) && campaigns.length) state.campaignId = campaigns[0].id;
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  const ouName = (id) => (orgUnits.find((o) => o.id === id) || {}).name || id;

  if (!isOk(campaigns) || !campaigns.length) {
    return `${pageHead("Queues", "Org units assigned to a campaign — wired to forecasting-service.", "")}
      <div class="panel">${empty("No campaigns yet.", "Create a campaign under Campaigns > Settings first.")}</div>`;
  }

  state.wf.campaignQueues = state.wf.campaignQueues || {};
  const queues = state.wf.campaignQueues[state.campaignId];
  if (!queues) loadCampaignQueues(state, state.campaignId);
  const rows = isOk(queues) ? queues : null;
  const assignedIds = new Set((rows || []).map((r) => r.orgUnitId));
  const available = orgUnits.filter((o) => !assignedIds.has(o.id));

  return `
    ${pageHead("Queues", "Org units assigned to a campaign — wired to forecasting-service.", "")}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Campaign</label>
      <select data-wf="campaign-picker">${campaigns.map((x) => `<option value="${x.id}" ${x.id === state.campaignId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    </div>
    ${sec("Assigned queues", `
      ${!rows
        ? (queues && queues.error ? `<p class="muted">${esc(queues.error)}</p>` : `<div class="skel" style="height:24px"></div>`)
        : `<table class="data"><thead><tr><th>Org unit</th><th>Added</th><th></th></tr></thead><tbody>${
            rows.map((r) => `<tr><td>${esc(ouName(r.orgUnitId))}</td><td class="mono">${new Date(r.addedAt).toLocaleDateString()}</td><td><button class="btn btn-sm" data-wf="remove-campaign-queue" data-id="${r.orgUnitId}">Remove</button></td></tr>`).join("")
            || `<tr><td colspan="3" class="muted">No queues assigned yet.</td></tr>`
          }</tbody></table>`}
      <div class="field" style="margin-top:10px;display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1"><label>Add org unit</label><select id="cq-add-ou" ${available.length ? "" : "disabled"}>${available.map((o) => `<option value="${o.id}">${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("") || `<option>No org units available</option>`}</select></div>
        <button class="btn" data-wf="add-campaign-queue" ${available.length ? "" : "disabled"}>+ Add</button>
      </div>
    `)}`;
}

export function render(state) {
  return state.tab === "campaign-queues" ? renderQueues(state) : renderSettings(state);
}

export function renderDrawer(state) {
  if (state.drawer !== "campaign") return "";
  const editing = state.editCampaignTarget;
  // Every field is captured live into state.campaignDraft as it changes
  // (see the campaign-field/campaign-dist-toggle handlers below), and this
  // drawer always renders FROM that draft, never straight from `editing` or
  // the raw DOM. Reproduced bug this fixes: a re-render landing between an
  // edit and clicking Save (e.g. a list refetch from a just-completed save
  // resolving, or the top bar's own `me` query) replaces this drawer's
  // entire innerHTML — any field not captured into persistent state reverts
  // silently to its original value. Confirmed with an actual dropped edit
  // before this fix, not a hypothetical.
  const d = state.campaignDraft || draftFor(editing);
  return drawerShell(editing ? "Edit campaign" : "Create campaign", editing ? "Update this campaign's details." : "Set up a new campaign — queues can be assigned afterward under Queues.",
    `<div class="field"><label>Name</label><input data-wf="campaign-field" data-id="name" placeholder="e.g. Q1 Support Surge" value="${esc(d.name)}" /></div>
     <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="campaign-field" data-id="description" value="${esc(d.description)}" /></div>
     <div class="grid-2" style="margin-top:10px">
       <div class="field"><label>Status</label>
         <select data-wf="campaign-field" data-id="status">
           ${["draft", "active", "paused", "completed"].map((s) => `<option value="${s}" ${d.status === s ? "selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join("")}
         </select>
       </div>
       <div></div>
       <div class="field"><label>Start date</label><input data-wf="campaign-field" data-id="startDate" type="date" value="${d.startDate}" /></div>
       <div class="field"><label>End date</label><input data-wf="campaign-field" data-id="endDate" type="date" value="${d.endDate}" /></div>
       <div class="field"><label>Time zone</label><input data-wf="campaign-field" data-id="timeZone" placeholder="e.g. America/New_York" value="${esc(d.timeZone)}" /></div>
       <div class="field"><label>Week start day</label>
         <select data-wf="campaign-field" data-id="weekStartDay"><option value="">—</option>${WEEK_DAYS.map((day) => `<option value="${day}" ${d.weekStartDay === day ? "selected" : ""}>${day[0]}${day.slice(1).toLowerCase()}</option>`).join("")}</select>
       </div>
       <div class="field"><label>Day boundary</label><input data-wf="campaign-field" data-id="dayBoundary" type="time" value="${d.dayBoundary}" /></div>
       <div class="field"><label>Scheduling period</label>
         <select data-wf="campaign-field" data-id="schedulingPeriod"><option value="">—</option>${PERIODS.map((p) => `<option value="${p}" ${d.schedulingPeriod === p ? "selected" : ""}>${p[0]}${p.slice(1).toLowerCase()}</option>`).join("")}</select>
       </div>
       <div class="field full"><label><input type="checkbox" data-wf="campaign-dist-toggle" ${d.isDistributedCampaign ? "checked" : ""} style="width:auto;margin-right:6px" />Distributed campaign</label></div>
     </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "campaign-edit-go" : "campaign-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.campaign ? "disabled" : ""}>${state.wf.saving.campaign ? "Saving…" : editing ? "Save" : "Create"}</button>`);
}

function draftFor(editing) {
  return {
    name: (editing && editing.name) || "",
    description: (editing && editing.description) || "",
    status: (editing && editing.status) || "draft",
    startDate: (editing && editing.startDate) || "",
    endDate: (editing && editing.endDate) || "",
    timeZone: (editing && editing.timeZone) || "",
    weekStartDay: (editing && editing.weekStartDay) || "",
    // Normalized to "HH:MM" up front — the <input type="time"> change
    // handler below also stores "HH:MM", so readCampaignForm can append
    // ":00" unconditionally without caring whether the value in the draft
    // came from the original load or a live edit.
    dayBoundary: (editing && editing.dayBoundary) ? editing.dayBoundary.slice(0, 5) : "",
    isDistributedCampaign: !!(editing && editing.isDistributedCampaign),
    schedulingPeriod: (editing && editing.schedulingPeriod) || "",
  };
}

function readCampaignForm(state) {
  const d = state.campaignDraft || draftFor(null);
  return {
    name: (d.name || "").trim(),
    description: (d.description || "").trim() || undefined,
    status: d.status || "draft",
    startDate: d.startDate || undefined,
    endDate: d.endDate || undefined,
    timeZone: (d.timeZone || "").trim() || undefined,
    weekStartDay: d.weekStartDay || undefined,
    dayBoundary: d.dayBoundary ? `${d.dayBoundary}:00` : undefined,
    isDistributedCampaign: !!d.isDistributedCampaign,
    schedulingPeriod: d.schedulingPeriod || undefined,
  };
}

export function handle(state, act, id, value) {
  if (act === "pick-campaign") { state.campaignId = id; return true; }
  if (act === "campaign-picker") { state.campaignId = value; return true; }

  if (act === "open-campaign") { state.editCampaignTarget = null; state.campaignDraft = draftFor(null); state.drawer = "campaign"; return true; }
  if (act === "edit-campaign") {
    state.editCampaignTarget = (isOk(state.wf.campaigns) ? state.wf.campaigns : []).find((c) => c.id === id);
    state.campaignDraft = draftFor(state.editCampaignTarget);
    state.drawer = "campaign";
    return true;
  }
  if (act === "campaign-field") { state.campaignDraft[id] = value; return true; }
  if (act === "campaign-dist-toggle") { state.campaignDraft.isDistributedCampaign = !state.campaignDraft.isDistributedCampaign; return true; }

  if (act === "campaign-go") {
    const body = readCampaignForm(state);
    if (!body.name) { toast("Campaign name is required."); return true; }
    if (body.startDate && body.endDate && body.endDate < body.startDate) { toast("End date must not be before start date."); return true; }
    state.wf.saving.campaign = true;
    doRerender();
    ForecastingApi.createCampaign(body)
      .then((created) => {
        state.wf.saving.campaign = false;
        state.wf.campaigns = null;
        state.campaignId = created.id;
        state.campaignDraft = null;
        state.drawer = null;
        toast("Campaign created.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.campaign = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "campaign-edit-go") {
    const body = readCampaignForm(state);
    if (!body.name) { toast("Campaign name is required."); return true; }
    if (body.startDate && body.endDate && body.endDate < body.startDate) { toast("End date must not be before start date."); return true; }
    state.wf.saving.campaign = true;
    doRerender();
    ForecastingApi.updateCampaign(id, body)
      .then(() => {
        state.wf.saving.campaign = false;
        state.wf.campaigns = null;
        state.campaignDraft = null;
        state.drawer = null;
        toast("Campaign saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.campaign = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "delete-campaign") {
    if (!confirm("Delete this campaign? Its queue assignments will be removed too.")) return true;
    ForecastingApi.deleteCampaign(id)
      .then(() => {
        state.wf.campaigns = null;
        state.campaignId = undefined;
        toast("Campaign deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "add-campaign-queue") {
    const orgUnitId = $("#cq-add-ou")?.value;
    if (!orgUnitId) return true;
    ForecastingApi.addCampaignQueue(state.campaignId, orgUnitId)
      .then(() => {
        state.wf.campaignQueues[state.campaignId] = null;
        toast("Queue added.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "remove-campaign-queue") {
    ForecastingApi.removeCampaignQueue(state.campaignId, id)
      .then(() => {
        state.wf.campaignQueues[state.campaignId] = null;
        toast("Queue removed.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
