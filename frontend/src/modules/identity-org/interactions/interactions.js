/* Interactions — manager/HR notes for one employee at a time. Wired to
   GraphQL createEmployeeInteraction/updateEmployeeInteraction/
   deleteEmployeeInteraction. Recording %, "system defined", inbox launch,
   and conditional custom data are deliberately NOT built — the page's own
   copy says they're reference concepts, not part of this data model. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, fmtDt, drawerShell } from '../shared/ui.js';
import { empById, empName, realOrgName } from '../shared/employee-helpers.js';
import { loadEmployees, loadUsers, loadEmployeeDetail } from '../shared/loaders.js';

async function loadInteractionSettings(state, orgUnitId) {
  try {
    const data = await Api.gqlFetch(`query($orgUnitId: ID!) { orgUnitInteractionSettings(orgUnitId: $orgUnitId) { orgUnitId isConfigured resolvedFromOrgUnitId inheritFromParent systemDefined audioRecordingPercentage videoRecordingPercentage screenRecordingPercentage inboxUrl conditionalCustomDataJson updatedAt } }`, { orgUnitId });
    state.wf.interactionSettings[orgUnitId] = data.orgUnitInteractionSettings;
  } catch (err) {
    state.wf.interactionSettings[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  state.wf.interactionSettings = state.wf.interactionSettings || {};
  if (!state.wf.employees) {
    loadEmployees(state);
    loadUsers(state);
    return pageHead("Interactions", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.ixEmp === null && state.wf.employees.length) state.ixEmp = state.wf.employees[0].id;
  const e = empById(state, state.ixEmp);
  if (e && !(e.id in state.wf.employeeDetail)) loadEmployeeDetail(state, e.id);
  const detail = e ? state.wf.employeeDetail[e.id] : undefined;
  const allNotes = (detail && !detail.error && detail.interactions) || [];
  const rows = allNotes.filter((n) => !state.ixType || n.interactionType === state.ixType);

  const orgUnitId = e ? e.orgUnitId : null;
  if (orgUnitId && !(orgUnitId in state.wf.interactionSettings)) loadInteractionSettings(state, orgUnitId);
  const settings = orgUnitId ? state.wf.interactionSettings[orgUnitId] : undefined;
  const draft = state.ixSettingsDraft && state.ixSettingsDraft.orgUnitId === orgUnitId ? state.ixSettingsDraft : null;
  const s = draft || settings;

  return `
    ${pageHead("Interactions", "Manager/HR notes for one employee at a time — editable/removable (updateEmployeeInteraction/deleteEmployeeInteraction).", `<button class="btn btn-primary" data-wf="open-note" ${e ? "" : "disabled"}>+ Add note</button>`)}
    <div class="split">
      <div class="split-l">${state.wf.employees.map((x) => `<button class="${x.id === state.ixEmp ? "on" : ""}" data-wf="ix-emp" data-id="${x.id}"><b>${esc(x.employeeNumber)}</b><div class="muted">${empName(state, x) || "—"}</div></button>`).join("")}</div>
      <div class="split-r">
        ${!e ? empty("Select an employee.") : `
        <div class="toolbar">
          <select data-wf="ix-type"><option value="">All types</option>${["COACHING", "DISCIPLINARY", "RECOGNITION", "ONE_ON_ONE", "GENERAL_NOTE"].map((t) => `<option value="${t}" ${state.ixType === t ? "selected" : ""}>${t.replaceAll("_", " ")}</option>`).join("")}</select>
          <select disabled title="EmployeeInteraction has no data_source column — a note isn't tagged as coming from Avaya/Genesys/etc., so there is nothing real to filter by yet"><option>Data source: not tracked on notes</option></select>
        </div>
        ${detail === undefined ? `<div class="skel" style="height:24px"></div>` : rows.length ? rows.map((n) => `<div class="note"><div class="k">${n.interactionType.replaceAll("_", " ")} · ${fmtDt(n.createdAt)}</div><div>${esc(n.body)}</div><div class="muted"><button class="btn btn-sm" data-wf="edit-note" data-id="${n.id}">Edit</button> <button class="btn btn-sm" data-wf="delete-note" data-id="${n.id}">Delete</button></div></div>`).join("") : empty("No interactions recorded.")}
        `}
      </div>
    </div>
    ${!e ? "" : sec(`Interaction settings — ${esc(realOrgName(state, orgUnitId))}`,
      !s ? `<div class="skel" style="height:16px"></div>`
      : s.error ? `<p class="muted">${esc(s.error)}</p>`
      : `<p class="hint" style="margin-top:0">Persisted per org unit (orgUnitInteractionSettings / upsertOrgUnitInteractionSettings). No telephony integration consumes these values yet — this is real, saved configuration, not a live recording control.</p>
        <label class="toggle"><input type="checkbox" id="ix-inherit-cb" data-wf="ix-inherit-toggle" ${s.inheritFromParent ? "checked" : ""} /> Inherit settings from current organization</label>
        ${s.inheritFromParent ? `<p class="muted" style="margin:6px 0 0">${s.isConfigured ? `Resolved from <b>${esc(realOrgName(state, s.resolvedFromOrgUnitId))}</b>.` : "No ancestor has configured settings — using platform defaults (no recording)."}</p>` : ""}
        <label class="toggle" style="margin-top:8px"><input type="checkbox" id="ix-sysdef-cb" data-wf="ix-sysdef-toggle" ${s.systemDefined ? "checked" : ""} /> System defined (use platform default instead of the values below)</label>
        <div class="grid-2" style="margin-top:10px">
          <div class="field"><label>Audio recording %</label><input type="number" min="0" max="100" data-wf="ix-audio" value="${s.audioRecordingPercentage ?? ""}" ${s.systemDefined ? "disabled" : ""} /></div>
          <div class="field"><label>Video recording %</label><input type="number" min="0" max="100" data-wf="ix-video" value="${s.videoRecordingPercentage ?? ""}" ${s.systemDefined ? "disabled" : ""} /></div>
          <div class="field"><label>Screen recording %</label><input type="number" min="0" max="100" data-wf="ix-screen" value="${s.screenRecordingPercentage ?? ""}" ${s.systemDefined ? "disabled" : ""} /></div>
          <div class="field"><label>Inbox URL</label><input data-wf="ix-inbox" value="${esc(s.inboxUrl || "")}" placeholder="No inbox integration exists — free text only" /></div>
        </div>
        <div class="field" style="margin-top:10px"><label>Conditional custom data (JSON)</label><textarea data-wf="ix-customdata" placeholder="{}">${esc(s.conditionalCustomDataJson || "")}</textarea></div>
        <div class="actions" style="margin-top:12px">
          <button class="btn btn-primary" data-wf="save-ix-settings" data-id="${orgUnitId}" ${state.wf.saving.ixSettings ? "disabled" : ""}>${state.wf.saving.ixSettings ? "Saving…" : "Save settings"}</button>
          ${s.inboxUrl ? `<a class="btn" href="${esc(s.inboxUrl)}" target="_blank" rel="noopener">Launch Inbox</a>` : `<button class="btn" disabled title="No Inbox URL configured">Launch Inbox</button>`}
        </div>`
    )}`;
}

export function renderDrawer(state) {
  const d = state.drawer;
  if (d === "note") {
    return drawerShell("Add interaction", "createEmployeeInteraction — insert-only create.",
      `<div class="field"><label>Type</label><select id="note-type"><option value="COACHING">Coaching</option><option value="DISCIPLINARY">Disciplinary</option><option value="RECOGNITION">Recognition</option><option value="ONE_ON_ONE">One on one</option><option value="GENERAL_NOTE">General note</option></select></div>
       <div class="field" style="margin-top:10px"><label>Body</label><textarea id="note-body"></textarea></div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="note-go" ${state.wf.saving.note ? "disabled" : ""}>${state.wf.saving.note ? "Saving…" : "Add note"}</button>`);
  }
  if (d === "edit-note") {
    const n = state.editNoteTarget;
    return drawerShell("Edit interaction", "updateEmployeeInteraction — only body is patchable.",
      `<div class="field"><label>Body</label><textarea id="note-edit-body">${esc(n.body)}</textarea></div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="note-edit-go" data-id="${n.id}" ${state.wf.saving.note ? "disabled" : ""}>${state.wf.saving.note ? "Saving…" : "Save"}</button>`);
  }
  return "";
}

function ensureDraft(state) {
  const e = empById(state, state.ixEmp);
  const orgUnitId = e ? e.orgUnitId : null;
  if (!state.ixSettingsDraft || state.ixSettingsDraft.orgUnitId !== orgUnitId) {
    const s = orgUnitId ? state.wf.interactionSettings[orgUnitId] : null;
    state.ixSettingsDraft = {
      orgUnitId,
      inheritFromParent: !!(s && s.inheritFromParent),
      systemDefined: !!(s && s.systemDefined),
      audioRecordingPercentage: (s && s.audioRecordingPercentage) ?? "",
      videoRecordingPercentage: (s && s.videoRecordingPercentage) ?? "",
      screenRecordingPercentage: (s && s.screenRecordingPercentage) ?? "",
      inboxUrl: (s && s.inboxUrl) || "",
      conditionalCustomDataJson: (s && s.conditionalCustomDataJson) || "",
    };
  }
  return state.ixSettingsDraft;
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "open-note") return set("drawer", "note");
  if (act === "ix-inherit-toggle") { ensureDraft(state).inheritFromParent = !!$("#ix-inherit-cb")?.checked; return true; }
  if (act === "ix-sysdef-toggle") { ensureDraft(state).systemDefined = !!$("#ix-sysdef-cb")?.checked; return true; }
  if (act === "ix-audio") { ensureDraft(state).audioRecordingPercentage = value; return false; }
  if (act === "ix-video") { ensureDraft(state).videoRecordingPercentage = value; return false; }
  if (act === "ix-screen") { ensureDraft(state).screenRecordingPercentage = value; return false; }
  if (act === "ix-inbox") { ensureDraft(state).inboxUrl = value; return false; }
  if (act === "ix-customdata") { ensureDraft(state).conditionalCustomDataJson = value; return false; }
  if (act === "save-ix-settings") {
    const d = ensureDraft(state);
    let conditionalCustomDataJson;
    if (d.conditionalCustomDataJson.trim()) {
      try {
        JSON.parse(d.conditionalCustomDataJson);
        conditionalCustomDataJson = d.conditionalCustomDataJson;
      } catch {
        toast("Conditional custom data must be valid JSON.");
        return true;
      }
    } else {
      conditionalCustomDataJson = null;
    }
    const input = {
      orgUnitId: id,
      inheritFromParent: d.inheritFromParent,
      systemDefined: d.systemDefined,
      audioRecordingPercentage: d.audioRecordingPercentage === "" ? null : Number(d.audioRecordingPercentage),
      videoRecordingPercentage: d.videoRecordingPercentage === "" ? null : Number(d.videoRecordingPercentage),
      screenRecordingPercentage: d.screenRecordingPercentage === "" ? null : Number(d.screenRecordingPercentage),
      inboxUrl: d.inboxUrl || null,
      conditionalCustomDataJson,
    };
    state.wf.saving.ixSettings = true;
    doRerender();
    Api.gqlFetch(`mutation($input: UpsertOrgUnitInteractionSettingsInput!) { upsertOrgUnitInteractionSettings(input: $input) { orgUnitId } }`, { input })
      .then(() => {
        state.wf.saving.ixSettings = false;
        state.ixSettingsDraft = null;
        delete state.wf.interactionSettings[id];
        toast("Interaction settings saved.");
        loadInteractionSettings(state, id);
      })
      .catch((err) => {
        state.wf.saving.ixSettings = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "note-go") {
    const interactionType = $("#note-type")?.value;
    const body = $("#note-body")?.value.trim();
    if (!body) {
      toast("Body is required.");
      return true;
    }
    state.wf.saving.note = true;
    Api.gqlFetch(
      `mutation($input: CreateEmployeeInteractionInput!) { createEmployeeInteraction(input: $input) { id } }`,
      { input: { employeeId: state.ixEmp, interactionType, body } }
    )
      .then(() => {
        state.wf.saving.note = false;
        delete state.wf.employeeDetail[state.ixEmp];
        state.drawer = null;
        toast("Note added.");
        loadEmployeeDetail(state, state.ixEmp);
      })
      .catch((err) => {
        state.wf.saving.note = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "edit-note") {
    const detail = state.wf.employeeDetail[state.ixEmp];
    state.editNoteTarget = (detail && detail.interactions || []).find((n) => n.id === id);
    return set("drawer", "edit-note");
  }
  if (act === "note-edit-go") {
    const body = $("#note-edit-body")?.value.trim();
    if (!body) {
      toast("Body is required.");
      return true;
    }
    state.wf.saving.note = true;
    Api.gqlFetch(`mutation($id: ID!, $body: String!) { updateEmployeeInteraction(id: $id, body: $body) { id } }`, { id, body })
      .then(() => {
        state.wf.saving.note = false;
        delete state.wf.employeeDetail[state.ixEmp];
        state.drawer = null;
        toast("Note updated.");
        loadEmployeeDetail(state, state.ixEmp);
      })
      .catch((err) => {
        state.wf.saving.note = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-note") {
    Api.gqlFetch(`mutation($id: ID!) { deleteEmployeeInteraction(id: $id) }`, { id })
      .then(() => {
        delete state.wf.employeeDetail[state.ixEmp];
        toast("Note deleted.");
        loadEmployeeDetail(state, state.ixEmp);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
