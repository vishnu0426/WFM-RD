/* Schedule Preferences — per-employee preferred shift windows + days off.
   Wired to GraphQL upsertEmployeeSchedulePreference (one row per employee).
   Ranked slots (First/Second/Third preference, Early/Late) and ordered
   days-off priority close the previously-disclosed backend gap — both are
   now real, persisted fields (EmployeeSchedulePreference.preferenceSlots,
   and preferredDaysOff's existing array order), not simplified away. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../shared/ui.js';
import { empById, empName, WEEKDAY_GQL, WEEKDAY_FROM_GQL, DAYS, DAY_S } from '../shared/employee-helpers.js';
import { loadEmployees, loadUsers, loadEmployeeDetail } from '../shared/loaders.js';

const RANKS = [1, 2, 3];
const RANK_LABEL = { 1: "First preference", 2: "Second preference", 3: "Third preference" };
/** GraphQL enum wire values are the TS enum's key (EARLY/LATE), not its lowercase value — same convention WEEKDAY_GQL/WEEKDAY_FROM_GQL already establish for Weekday. */
const EARLYLATE_GQL = { early: "EARLY", late: "LATE" };
const EARLYLATE_FROM_GQL = { EARLY: "early", LATE: "late" };
const emptySlot = (rank) => ({ rank, startTime: "", endTime: "", earlyLate: "" });

function slotsFromDetail(p) {
  const stored = (p && p.preferenceSlots) || [];
  return RANKS.map((rank) => {
    const found = stored.find((s) => s.rank === rank);
    return found ? { rank, startTime: found.startTime || "", endTime: found.endTime || "", earlyLate: EARLYLATE_FROM_GQL[found.earlyLate] || "" } : emptySlot(rank);
  });
}

export function render(state) {
  if (!state.wf.employees) {
    loadEmployees(state);
    loadUsers(state);
    return pageHead("Schedule Preferences", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.prefEmp === null && state.wf.employees.length) state.prefEmp = state.wf.employees[0].id;
  const e = empById(state, state.prefEmp);
  if (e && !(e.id in state.wf.employeeDetail)) loadEmployeeDetail(state, e.id);
  const detail = e ? state.wf.employeeDetail[e.id] : undefined;
  const p = detail && !detail.error ? detail.schedulePreference : null;
  const off = state.prefDaysDraft
    ? [...state.prefDaysDraft]
    : (p && p.preferredDaysOff || []).map((d) => WEEKDAY_FROM_GQL[d] || d.toLowerCase());
  const slots = state.prefSlotsDraft || slotsFromDetail(p);
  state.prefSlotsDraft = slots;
  const unusedDays = DAYS.filter((d) => !off.includes(d));
  return `
    ${pageHead("Schedule Preferences", "Per-employee preferred windows and days off. Not a Work Pattern.", "")}
    <div class="split">
      <div class="split-l">${state.wf.employees.map((x) => `<button class="${x.id === state.prefEmp ? "on" : ""}" data-wf="pref-emp" data-id="${x.id}"><b>${esc(x.employeeNumber)}</b><div class="muted">${empName(state, x) || "—"}</div></button>`).join("")}</div>
      <div class="split-r">
        ${!e ? empty("Select an employee.") : `
        <h2 style="margin:0 0 8px;font-size:16px">${esc(e.employeeNumber)} · ${esc(empName(state, e) || "—")}</h2>
        <p class="hint">upsertEmployeeSchedulePreference · one row per employee.</p>
        ${detail === undefined ? `<div class="skel" style="height:24px"></div>` : `
        ${sec("Ranked shift-window preferences", `<p class="hint" style="margin-top:0">First / Second / Third preference, each with an optional Early or Late bias — all optional and independent of each other.</p>
          <div class="grid-2" style="gap:14px">
          ${RANKS.map((rank, i) => `<div class="field full" style="border:1px solid var(--border,#2a2f3a);border-radius:8px;padding:10px">
            <label><b>${RANK_LABEL[rank]}</b></label>
            <div class="grid-2" style="margin-top:6px">
              <div class="field"><label>Start</label><input type="time" data-wf="slot-start" data-id="${rank}" value="${esc(slots[i].startTime)}" /></div>
              <div class="field"><label>End</label><input type="time" data-wf="slot-end" data-id="${rank}" value="${esc(slots[i].endTime)}" /></div>
              <div class="field"><label>Bias</label><select data-wf="slot-bias" data-id="${rank}">
                <option value="" ${!slots[i].earlyLate ? "selected" : ""}>None</option>
                <option value="early" ${slots[i].earlyLate === "early" ? "selected" : ""}>Early</option>
                <option value="late" ${slots[i].earlyLate === "late" ? "selected" : ""}>Late</option>
              </select></div>
            </div>
          </div>`).join("")}
          </div>`)}
        ${sec("Legacy single window + max hours", `<div class="grid-2">
          <div class="field"><label>Preferred shift start</label><input type="time" id="pref-start" value="${(p && p.preferredShiftStart) || ""}" /></div>
          <div class="field"><label>Preferred shift end</label><input type="time" id="pref-end" value="${(p && p.preferredShiftEnd) || ""}" /></div>
          <div class="field"><label>Max weekly hours</label><input type="number" id="pref-max" value="${(p && p.maxWeeklyHours) || ""}" /></div>
          <div class="field full"><label>Notes</label><textarea id="pref-notes">${esc((p && p.notes) || "")}</textarea></div>
        </div>`)}
        ${sec("Preferred days off — ordered by priority", `
          ${off.length ? `<ol class="days-off-priority" style="margin:0 0 10px;padding:0;list-style:none;display:grid;gap:6px">
            ${off.map((d, i) => `<li style="display:flex;align-items:center;gap:8px">
              <b class="mono" style="width:20px">${i + 1}.</b>
              <span style="flex:1">${DAY_S[d]}</span>
              <button class="btn btn-sm" data-wf="pref-day-up" data-id="${d}" ${i === 0 ? "disabled" : ""} aria-label="Move ${DAY_S[d]} up">↑</button>
              <button class="btn btn-sm" data-wf="pref-day-down" data-id="${d}" ${i === off.length - 1 ? "disabled" : ""} aria-label="Move ${DAY_S[d]} down">↓</button>
              <button class="btn btn-sm" data-wf="pref-day-remove" data-id="${d}" aria-label="Remove ${DAY_S[d]}">Remove</button>
            </li>`).join("")}
          </ol>` : `<p class="muted" style="margin-top:0">No days off selected yet.</p>`}
          ${unusedDays.length ? `<div class="toolbar" style="margin-top:4px">
            <select id="pref-add-day">${unusedDays.map((d) => `<option value="${d}">${DAY_S[d]}</option>`).join("")}</select>
            <button class="btn btn-sm" data-wf="pref-day-add">+ Add day off</button>
          </div>` : ""}
          <p class="hint">Order is the priority — first row is the day off that matters most if not all can be granted.</p>`)}
        <button class="btn btn-primary" data-wf="save-pref" data-id="${e.id}" ${state.wf.saving.pref ? "disabled" : ""}>${state.wf.saving.pref ? "Saving…" : "Save preference"}</button>
        `}`}
      </div>
    </div>`;
}

function currentDaysDraft(state) {
  if (!state.prefDaysDraft) {
    const detail = state.wf.employeeDetail[state.prefEmp];
    const p = detail && !detail.error ? detail.schedulePreference : null;
    state.prefDaysDraft = (p && p.preferredDaysOff || []).map((d) => WEEKDAY_FROM_GQL[d] || d.toLowerCase());
  }
  return state.prefDaysDraft;
}

export function handle(state, act, id, value) {
  if (act === "slot-start" || act === "slot-end" || act === "slot-bias") {
    const rank = Number(id);
    const slots = state.prefSlotsDraft || slotsFromDetail(null);
    const slot = slots.find((s) => s.rank === rank);
    if (slot) {
      if (act === "slot-start") slot.startTime = value;
      if (act === "slot-end") slot.endTime = value;
      if (act === "slot-bias") slot.earlyLate = value;
    }
    state.prefSlotsDraft = slots;
    return false;
  }
  if (act === "pref-day-add") {
    const sel = $("#pref-add-day");
    const day = sel && sel.value;
    if (!day) return true;
    const days = currentDaysDraft(state);
    if (!days.includes(day)) days.push(day);
    state.prefDaysDraft = [...days];
    return true;
  }
  if (act === "pref-day-remove") {
    const days = currentDaysDraft(state).filter((d) => d !== id);
    state.prefDaysDraft = days;
    return true;
  }
  if (act === "pref-day-up") {
    const days = currentDaysDraft(state);
    const i = days.indexOf(id);
    if (i > 0) {
      const a = days.slice();
      [a[i - 1], a[i]] = [a[i], a[i - 1]];
      state.prefDaysDraft = a;
    }
    return true;
  }
  if (act === "pref-day-down") {
    const days = currentDaysDraft(state);
    const i = days.indexOf(id);
    if (i >= 0 && i < days.length - 1) {
      const a = days.slice();
      [a[i + 1], a[i]] = [a[i], a[i + 1]];
      state.prefDaysDraft = a;
    }
    return true;
  }
  if (act === "save-pref") {
    const days = state.prefDaysDraft || currentDaysDraft(state);
    const slots = (state.prefSlotsDraft || []).filter((s) => s.startTime || s.endTime || s.earlyLate);
    const input = {
      employeeId: id,
      preferredShiftStart: $("#pref-start")?.value || undefined,
      preferredShiftEnd: $("#pref-end")?.value || undefined,
      maxWeeklyHours: $("#pref-max")?.value ? Number($("#pref-max").value) : undefined,
      notes: $("#pref-notes")?.value || undefined,
      preferredDaysOff: days.map((d) => WEEKDAY_GQL[d] || d.toUpperCase()),
      preferenceSlots: slots.length
        ? slots.map((s) => ({ rank: s.rank, startTime: s.startTime || undefined, endTime: s.endTime || undefined, earlyLate: EARLYLATE_GQL[s.earlyLate] || undefined }))
        : undefined,
    };
    state.wf.saving.pref = true;
    doRerender();
    Api.gqlFetch(`mutation($input: UpsertEmployeeSchedulePreferenceInput!) { upsertEmployeeSchedulePreference(input: $input) { employeeId } }`, { input })
      .then(() => {
        state.wf.saving.pref = false;
        state.prefDaysDraft = null;
        state.prefSlotsDraft = null;
        delete state.wf.employeeDetail[id];
        toast("Preference saved.");
        loadEmployeeDetail(state, id);
      })
      .catch((err) => {
        state.wf.saving.pref = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
