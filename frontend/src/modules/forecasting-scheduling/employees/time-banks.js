/* Employees > Time Banks — wired to the root platform-core service's GraphQL
   API (src/modules/employee/time-bank.module.ts). An append-only signed
   ledger per employee (positive hours = accrual, negative = draw-down); the
   balance is always a live sum over the ledger, never a stored column — see
   TimeBankEntry's own doc comment. No edit/delete mutation exists
   (append-only by design; corrections are offsetting entries), so this
   screen only ever adds entries, never edits or removes one. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { Api } from '../../../core/api.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell, fmtDt } from '../../identity-org/shared/ui.js';
import { loadEmployees } from '../../identity-org/shared/loaders.js';
import { empById, empLabel } from '../../identity-org/shared/employee-helpers.js';

const isOk = (x) => Array.isArray(x);

async function loadTimeBank(state, employeeId) {
  state.wf.timeBankEntries = state.wf.timeBankEntries || {};
  state.wf.timeBankBalance = state.wf.timeBankBalance || {};
  try {
    const data = await Api.gqlFetch(
      `query($employeeId: ID!) { timeBankEntries(employeeId: $employeeId) { id hours reason entryDate createdAt } timeBankBalance(employeeId: $employeeId) }`,
      { employeeId }
    );
    state.wf.timeBankEntries[employeeId] = data.timeBankEntries;
    state.wf.timeBankBalance[employeeId] = data.timeBankBalance;
  } catch (err) {
    state.wf.timeBankEntries[employeeId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  loadEmployees(state);
  const employees = isOk(state.wf.employees) ? state.wf.employees : [];
  if (state.tbEmpId === undefined && employees.length) state.tbEmpId = employees[0].id;

  if (!employees.length) {
    return `${pageHead("Time Banks", "Accrued/drawn-down hours ledger, per employee — wired to the platform-core service.", "")}
      <div class="panel">${empty("No employees yet.")}</div>`;
  }

  state.wf.timeBankEntries = state.wf.timeBankEntries || {};
  state.wf.timeBankBalance = state.wf.timeBankBalance || {};
  const entries = state.wf.timeBankEntries[state.tbEmpId];
  if (entries === undefined) loadTimeBank(state, state.tbEmpId);
  const balance = state.wf.timeBankBalance[state.tbEmpId];

  return `
    ${pageHead("Time Banks", "Accrued/drawn-down hours ledger, per employee — wired to the platform-core service.", `<button class="btn btn-primary" data-wf="tb-open" ${state.tbEmpId ? "" : "disabled"}>+ Add entry</button>`)}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Employee</label>
      <select data-wf="tb-picker">${employees.map((e) => `<option value="${e.id}" ${e.id === state.tbEmpId ? "selected" : ""}>${esc(empLabel(state, e))}</option>`).join("")}</select>
    </div>
    ${sec("Balance", !isOk(entries) && entries === undefined ? `<div class="skel" style="height:20px"></div>` : `<div class="mono" style="font-size:20px;font-weight:600">${balance != null ? `${balance} hrs` : "—"}</div>`)}
    ${sec("Ledger", !entries
      ? `<div class="skel" style="height:24px"></div>`
      : !isOk(entries) ? `<p class="muted">${esc(entries.error)}</p>`
      : `<table class="data"><thead><tr><th>Date</th><th>Hours</th><th>Reason</th><th>Recorded</th></tr></thead><tbody>${
          entries.map((e) => `<tr><td class="mono">${e.entryDate}</td><td class="mono" style="color:${e.hours < 0 ? "var(--danger,#c0392b)" : "inherit"}">${e.hours > 0 ? "+" : ""}${e.hours}</td><td>${esc(e.reason)}</td><td class="muted">${fmtDt(e.createdAt)}</td></tr>`).join("")
          || `<tr><td colspan="4" class="muted">No entries yet.</td></tr>`
        }</tbody></table>`)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== "tb") return "";
  return drawerShell("Add time bank entry", "addTimeBankEntry (GraphQL mutation)",
    `<div class="grid-2">
       <div class="field"><label>Hours (negative to draw down)</label><input id="tb-hours" type="number" step="0.25" /></div>
       <div class="field"><label>Entry date</label><input id="tb-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
       <div class="field full"><label>Reason</label><input id="tb-reason" placeholder="e.g. Overtime accrual — week of Sep 1" /></div>
     </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="tb-go" ${state.wf.saving.tb ? "disabled" : ""}>${state.wf.saving.tb ? "Saving…" : "Add entry"}</button>`);
}

export function handle(state, act, id, value) {
  if (act === "tb-picker") { state.tbEmpId = value; return true; }
  if (act === "tb-open") { state.drawer = "tb"; return true; }

  if (act === "tb-go") {
    const hoursRaw = $("#tb-hours")?.value;
    const entryDate = $("#tb-date")?.value;
    const reason = $("#tb-reason")?.value.trim();
    if (!hoursRaw || Number(hoursRaw) === 0) { toast("Hours is required and must not be zero."); return true; }
    if (!entryDate) { toast("Entry date is required."); return true; }
    if (!reason) { toast("Reason is required."); return true; }
    state.wf.saving.tb = true;
    doRerender();
    Api.gqlFetch(
      `mutation($employeeId: ID!, $hours: Float!, $reason: String!, $entryDate: String!) {
        addTimeBankEntry(employeeId: $employeeId, hours: $hours, reason: $reason, entryDate: $entryDate) { id }
      }`,
      { employeeId: state.tbEmpId, hours: Number(hoursRaw), reason, entryDate }
    )
      .then(() => {
        state.wf.saving.tb = false;
        state.wf.timeBankEntries[state.tbEmpId] = undefined;
        state.drawer = null;
        toast("Entry added.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tb = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
