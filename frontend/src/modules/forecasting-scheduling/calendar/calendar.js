/* Calendar — the WFM timeline grid: employees as rows, time as a
   horizontal axis, scheduled/actual activity as positioned blocks. Three
   real view modes, each backed by a distinct real endpoint:
     Schedule  - roster board: GET /v1/scheduling/shift-assignments
                 (built specifically for this — see its own doc comment)
     Coverage  - required (Tactical Forecast data points, if a completed
                 run exists) vs scheduled (derived from real assignments),
                 plus the live queue snapshot
     Adherence - GraphQL agentLiveState(employeeId) per employee, plus real
                 Adherence Exceptions (their own real start/end timestamps,
                 overlaid on the timeline) with acknowledge/resolve

   No 4th "Activities" mode: there's no backend concept for it beyond what
   Schedule already shows. No sub-shift activity blocks (Break/Lunch/
   Training) either — ShiftAssignment is one continuous block per row, no
   sub-segmentation exists in the persisted schedule; faking that
   granularity would be inventing data. No drag/resize: there's no backend
   endpoint to change an assignment's time, only override() to reassign a
   different employee to the same slot — genuinely unsupported, not a
   frontend gap. No full planned-vs-actual activity timeline: AdherenceEvent
   (the only record of real actual activity) is never exposed by any API —
   confirmed by reading every controller/resolver in intraday-service.
   AdherenceException segments (real timestamps, but exceptions only, not
   the full stream) are the most complete "actual" data that exists, and
   are what the Adherence overlay uses. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, fmtDt, drawerShell } from '../../identity-org/shared/ui.js';
import { loadOrgUnits, loadUsers } from '../../identity-org/shared/loaders.js';
import { empLabel } from '../../identity-org/shared/employee-helpers.js';
import * as SchedulingApi from '../../scheduling/api.js';
import * as IntradayApi from '../../intraday/api.js';
import * as ForecastingApi from '../../forecasting/api.js';
import * as LeaveApi from '../../attendance-leave/api.js';

const isOk = (x) => Array.isArray(x);
const HOUR_PX_100 = 60; // px per hour at 100% zoom

/* ---------- date/time helpers ---------- */
function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
function startOfWeek(d) { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() - day); return x; }
function addDays(dateStr, n) { const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
function daysBetween(fromStr, toStr) {
  const out = [];
  let d = new Date(fromStr + "T00:00:00Z");
  const end = new Date(toStr + "T00:00:00Z");
  while (d <= end) { out.push(isoDate(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

/* The UTC instant corresponding to local midnight of `dateStr` (YYYY-MM-DD)
   in IANA zone `tz` — converges in 2-3 passes via Intl (no library). Used
   so the grid's day boundary, activity positions, and the now-indicator
   all share one timezone-correct reference frame instead of assuming UTC
   or the browser's own local zone. */
function localMidnightUtc(dateStr, tz) {
  let guess = new Date(dateStr + "T00:00:00Z");
  const desired = guess.getTime();
  for (let i = 0; i < 3; i++) {
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(guess);
    } catch {
      return guess; // invalid/unknown tz — fall back to UTC-as-is
    }
    const get = (t) => parts.find((p) => p.type === t).value;
    const seenAsUtc = Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}:${get("second")}Z`);
    guess = new Date(guess.getTime() + (desired - seenAsUtc));
  }
  return guess;
}

function tzLabel(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value || tz;
  } catch {
    return tz;
  }
}

/* ---------- loaders ---------- */
async function loadRosterEmployees(state, orgUnitId) {
  state.wf.calRoster = state.wf.calRoster || {};
  try {
    const data = await Api.gqlFetch(
      `query($filter: EmployeeFilterInput) {
        employees(filter: $filter, pagination: {limit: 200, offset: 0}) {
          id employeeNumber orgUnitId userId
          managerEmployeeId teamLeadEmployeeId isSupervisor isTeamLead
          manager { id employeeNumber userId }
          teamLead { id employeeNumber userId }
          groups { id name }
        }
      }`,
      { filter: { orgUnitId } }
    );
    state.wf.calRoster[orgUnitId] = data.employees;
  } catch (err) {
    state.wf.calRoster[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadOuTimezone(state, orgUnitId) {
  state.wf.calOuTz = state.wf.calOuTz || {};
  try {
    const data = await Api.gqlFetch(`query($id: ID!) { orgUnit(id: $id) { id timezone } }`, { id: orgUnitId });
    state.wf.calOuTz[orgUnitId] = data.orgUnit?.timezone || null;
  } catch {
    state.wf.calOuTz[orgUnitId] = null;
  }
  doRerender();
}

async function loadAssignments(state, key, employeeIds, from, to) {
  state.wf.calAssignments = state.wf.calAssignments || {};
  try {
    state.wf.calAssignments[key] = await SchedulingApi.listShiftAssignments(employeeIds, from, to);
  } catch (err) {
    state.wf.calAssignments[key] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadLeaveToday(state, orgUnitId) {
  state.wf.calLeave = state.wf.calLeave || {};
  try {
    state.wf.calLeave[orgUnitId] = await LeaveApi.listLeaveRequests(orgUnitId, "approved");
  } catch (err) {
    state.wf.calLeave[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadQueueLive(state, orgUnitId) {
  state.wf.calQueueLive = state.wf.calQueueLive || {};
  try {
    state.wf.calQueueLive[orgUnitId] = await IntradayApi.getQueueLive(orgUnitId);
  } catch (err) {
    state.wf.calQueueLive[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadAgentLive(state, key, employeeIds) {
  state.wf.calAgentLive = state.wf.calAgentLive || {};
  try {
    state.wf.calAgentLive[key] = await IntradayApi.getAgentLiveStates(employeeIds);
  } catch (err) {
    state.wf.calAgentLive[key] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadExceptionsForOu(state, key, employeeIds) {
  state.wf.calExceptionsByOu = state.wf.calExceptionsByOu || {};
  try {
    const perEmp = await Promise.all(employeeIds.map((id) => IntradayApi.listAdherenceExceptions({ employeeId: id }).catch(() => [])));
    state.wf.calExceptionsByOu[key] = perEmp.flat();
  } catch (err) {
    state.wf.calExceptionsByOu[key] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadExceptions(state, employeeId) {
  state.wf.calExceptions = state.wf.calExceptions || {};
  try {
    state.wf.calExceptions[employeeId] = await IntradayApi.listAdherenceExceptions({ employeeId });
  } catch (err) {
    state.wf.calExceptions[employeeId] = { error: errMsg(err) };
  }
  doRerender();
}

/* ---------- state defaults ---------- */
function initDefaults(state) {
  if (!state.calFrom) {
    const monday = startOfWeek(new Date());
    state.calFrom = isoDate(monday);
  }
  state.calRangeMode = state.calRangeMode || "day";
  state.calViewMode = state.calViewMode || "schedule";
  state.calZoom = state.calZoom || 100;
  state.calGroupBy = state.calGroupBy || "none";
  state.calGroupCollapsed = state.calGroupCollapsed || new Set();
  state.calSearch = state.calSearch || "";
}

function rangeDates(state) {
  if (state.calRangeMode === "week") {
    const monday = isoDate(startOfWeek(new Date(state.calFrom + "T00:00:00Z")));
    return { from: monday, to: addDays(monday, 6) };
  }
  return { from: state.calFrom, to: state.calFrom };
}

/* ---------- grouping ---------- */
function groupLabel(state, employees, groupBy) {
  if (groupBy === "supervisor") {
    return (e) => e.managerEmployeeId ? `Supervisor: ${esc(empLabel(state, e.manager || { employeeNumber: e.managerEmployeeId }))}` : "No supervisor";
  }
  if (groupBy === "teamlead") {
    return (e) => e.teamLeadEmployeeId ? `Team Lead: ${esc(empLabel(state, e.teamLead || { employeeNumber: e.teamLeadEmployeeId }))}` : "No team lead";
  }
  if (groupBy === "group") {
    return (e) => (e.groups && e.groups.length ? e.groups.map((g) => g.name).join(", ") : "No group");
  }
  return null;
}

function buildGroups(state, employees) {
  const labelFn = groupLabel(state, employees, state.calGroupBy);
  if (!labelFn) return [{ key: "__all__", label: null, employees }];
  const map = new Map();
  employees.forEach((e) => {
    const label = labelFn(e);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(e);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, emps]) => ({ key: label, label, employees: emps }));
}

function filterBySearch(employees, state, search) {
  if (!search.trim()) return employees;
  const q = search.trim().toLowerCase();
  return employees.filter((e) => {
    const label = empLabel(state, e).toLowerCase();
    return label.includes(q) || (e.employeeNumber || "").toLowerCase().includes(q);
  });
}

/* ---------- Day timeline grid ---------- */
function hourWidthPx(zoom) { return Math.round((HOUR_PX_100 * zoom) / 100); }

function positionBlock(startIso, endIso, dayStartUtc, hourPx) {
  const startMin = (new Date(startIso) - dayStartUtc) / 60000;
  const endMin = (new Date(endIso) - dayStartUtc) / 60000;
  const clampedStart = Math.max(0, startMin);
  const clampedEnd = Math.min(24 * 60, endMin);
  const leftPx = (clampedStart / 60) * hourPx;
  const widthPx = Math.max(4, ((clampedEnd - clampedStart) / 60) * hourPx);
  return { leftPx, widthPx, offGridStart: startMin < 0, offGridEnd: endMin > 24 * 60 };
}

function renderHourHeader(dayStartUtc, tz, hourPx) {
  const cells = [];
  for (let h = 0; h < 24; h++) {
    const instant = new Date(dayStartUtc.getTime() + h * 3600000);
    let label;
    try {
      label = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
    } catch {
      label = `${String(h).padStart(2, "0")}:00`;
    }
    cells.push(`<div class="wfm-hour-cell" style="width:${hourPx}px">${label}</div>`);
  }
  return cells.join("");
}

function renderDayGrid(state, groups, from) {
  const hourPx = hourWidthPx(state.calZoom);
  const totalWidth = hourPx * 24;
  const tz = state.wf.calOuTz && state.wf.calOuTz[state.calOu];
  const dayStartUtc = localMidnightUtc(from, tz || "UTC");
  const nowMin = (Date.now() - dayStartUtc.getTime()) / 60000;
  const showNow = nowMin >= 0 && nowMin <= 24 * 60;
  const nowLeftPx = (nowMin / 60) * hourPx;

  const key = `${state.calOu}|${from}|${from}`;
  const rows = state.wf.calAssignments && state.wf.calAssignments[key];
  if (rows === undefined) {
    const allEmployees = groups.flatMap((g) => g.employees);
    loadAssignments(state, key, allEmployees.map((e) => e.id), `${from}T00:00:00Z`, `${addDays(from, 1)}T00:00:00Z`);
  }
  if (!rows) return `<div class="skel" style="height:120px"></div>`;
  if (!isOk(rows)) return `<p class="muted">${esc(rows.error)}</p>`;

  state.wf.calLeave = state.wf.calLeave || {};
  const leave = state.wf.calLeave[state.calOu];
  if (leave === undefined) loadLeaveToday(state, state.calOu);
  const leaveRows = isOk(leave) ? leave.filter((r) => r.dateRangeStart <= from && r.dateRangeEnd >= from) : [];

  let exceptions = null;
  if (state.calViewMode === "adherence") {
    const excKey = state.calOu;
    exceptions = state.wf.calExceptionsByOu && state.wf.calExceptionsByOu[excKey];
    if (exceptions === undefined) {
      const allEmployees = groups.flatMap((g) => g.employees);
      loadExceptionsForOu(state, excKey, allEmployees.map((e) => e.id));
    }
  }

  const rowHtml = (e) => {
    const empAssignments = rows.filter((a) => a.employeeId === e.id);
    const empLeave = leaveRows.filter((r) => r.employeeId === e.id);
    const blocks = [];
    empAssignments.forEach((a) => {
      const p = positionBlock(a.shiftStart, a.shiftEnd, dayStartUtc, hourPx);
      blocks.push(`<button type="button" class="wfm-block ${a.isOvertime ? "wfm-block-ot" : "wfm-block-work"}" data-wf="cal-activity" data-id="${a.id}" style="left:${p.leftPx}px;width:${p.widthPx}px" title="${esc(fmtTime(a.shiftStart))}–${esc(fmtTime(a.shiftEnd))}${a.isOvertime ? " · overtime" : ""}${a.locked ? " · locked" : ""}"><span class="wfm-block-label">${esc(fmtTime(a.shiftStart))}–${esc(fmtTime(a.shiftEnd))}${a.isOvertime ? " OT" : ""}</span></button>`);
    });
    empLeave.forEach((r) => {
      blocks.push(`<div class="wfm-block wfm-block-timeoff" style="left:0;width:${totalWidth}px" title="Approved time off"><span class="wfm-block-label">Time off</span></div>`);
    });
    if (state.calViewMode === "adherence" && isOk(exceptions)) {
      exceptions.filter((x) => x.employeeId === e.id).forEach((x) => {
        const p = positionBlock(x.startedAt, x.endedAt, dayStartUtc, hourPx);
        blocks.push(`<div class="wfm-block wfm-block-exception" style="left:${p.leftPx}px;width:${p.widthPx}px" title="${esc(x.activity)} — ${Math.round(x.deviationSeconds / 60)} min deviation"><span class="wfm-block-label">⚠ ${esc(x.activity)}</span></div>`);
      });
    }
    return `
      <div class="wfm-row">
        <div class="wfm-emp-cell">
          <button class="wfm-emp-toggle" data-wf="cal-toggle-emp" data-id="${e.id}">${state.calExpanded && state.calExpanded.has(e.id) ? "▾" : "▸"} ${esc(empLabel(state, e))}</button>
        </div>
        <div class="wfm-row-track" style="width:${totalWidth}px;background-image:repeating-linear-gradient(to right, var(--line-2) 0, var(--line-2) 1px, transparent 1px, transparent ${hourPx}px)">${blocks.join("")}</div>
      </div>
      ${state.calExpanded && state.calExpanded.has(e.id) ? `<div class="wfm-row wfm-row-expand"><div class="wfm-emp-cell"></div><div style="width:${totalWidth}px;padding:10px 14px">${renderEmployeeExpansion(state, e)}</div></div>` : ""}
    `;
  };

  const groupsHtml = groups.map((g) => {
    const collapsed = g.label && state.calGroupCollapsed.has(g.key);
    return `
      ${g.label ? `<div class="wfm-row wfm-group-row"><div class="wfm-emp-cell"><button class="wfm-emp-toggle" data-wf="cal-group-toggle" data-id="${esc(g.key)}">${collapsed ? "▸" : "▾"} ${g.label} <span class="muted">(${g.employees.length})</span></button></div><div style="width:${totalWidth}px"></div></div>` : ""}
      ${collapsed ? "" : g.employees.map(rowHtml).join("")}
    `;
  }).join("");

  return `
    <div class="wfm-timeline">
      <div class="wfm-timeline-scroll">
        <div class="wfm-timeline-header">
          <div class="wfm-emp-col-header">Employee${tz ? ` <span class="muted" style="font-weight:400">(${esc(tzLabel(tz))})</span>` : ""}</div>
          <div class="wfm-hours" style="width:${totalWidth}px">${renderHourHeader(dayStartUtc, tz, hourPx)}</div>
        </div>
        <div class="wfm-body" style="position:relative">
          ${showNow ? `<div class="wfm-now-line" style="left:${222 + nowLeftPx}px" title="Now${tz ? ` (${esc(tzLabel(tz))})` : ""}"></div>` : ""}
          ${groupsHtml || `<div class="wfm-row"><div class="wfm-emp-cell muted">No employees in this org unit.</div></div>`}
        </div>
      </div>
    </div>`;
}

/* ---------- Week view: proportional mini-bars per day ---------- */
function renderWeekGrid(state, groups, from, to) {
  const days = daysBetween(from, to);
  const key = `${state.calOu}|${from}|${to}`;
  const rows = state.wf.calAssignments && state.wf.calAssignments[key];
  if (rows === undefined) {
    const allEmployees = groups.flatMap((g) => g.employees);
    loadAssignments(state, key, allEmployees.map((e) => e.id), `${from}T00:00:00Z`, `${addDays(to, 1)}T00:00:00Z`);
  }
  if (!rows) return `<div class="skel" style="height:120px"></div>`;
  if (!isOk(rows)) return `<p class="muted">${esc(rows.error)}</p>`;

  const dayCellPx = 130;
  const rowHtml = (e) => {
    const cells = days.map((d) => {
      const dayStart = new Date(d + "T00:00:00Z");
      const dayEnd = new Date(d + "T23:59:59.999Z");
      const dayAssignments = rows.filter((a) => a.employeeId === e.id && new Date(a.shiftStart) <= dayEnd && new Date(a.shiftEnd) >= dayStart);
      const bars = dayAssignments.map((a) => {
        const p = positionBlock(a.shiftStart, a.shiftEnd, dayStart, dayCellPx / 24);
        return `<button type="button" class="wfm-block wfm-block-mini ${a.isOvertime ? "wfm-block-ot" : "wfm-block-work"}" data-wf="cal-activity" data-id="${a.id}" style="left:${p.leftPx}px;width:${p.widthPx}px" title="${esc(fmtTime(a.shiftStart))}–${esc(fmtTime(a.shiftEnd))}"></button>`;
      }).join("");
      return `<div class="wfm-week-cell" style="width:${dayCellPx}px" data-wf="cal-week-day" data-id="${d}">${bars || `<span class="muted" style="font-size:11px">—</span>`}</div>`;
    }).join("");
    return `
      <div class="wfm-row">
        <div class="wfm-emp-cell">
          <button class="wfm-emp-toggle" data-wf="cal-toggle-emp" data-id="${e.id}">${state.calExpanded && state.calExpanded.has(e.id) ? "▾" : "▸"} ${esc(empLabel(state, e))}</button>
        </div>
        <div class="wfm-row-track wfm-week-track" style="width:${dayCellPx * days.length}px">${cells}</div>
      </div>
      ${state.calExpanded && state.calExpanded.has(e.id) ? `<div class="wfm-row wfm-row-expand"><div class="wfm-emp-cell"></div><div style="width:${dayCellPx * days.length}px;padding:10px 14px">${renderEmployeeExpansion(state, e)}</div></div>` : ""}
    `;
  };

  const groupsHtml = groups.map((g) => {
    const collapsed = g.label && state.calGroupCollapsed.has(g.key);
    return `
      ${g.label ? `<div class="wfm-row wfm-group-row"><div class="wfm-emp-cell"><button class="wfm-emp-toggle" data-wf="cal-group-toggle" data-id="${esc(g.key)}">${collapsed ? "▸" : "▾"} ${g.label} <span class="muted">(${g.employees.length})</span></button></div><div style="width:${dayCellPx * days.length}px"></div></div>` : ""}
      ${collapsed ? "" : g.employees.map(rowHtml).join("")}
    `;
  }).join("");

  return `
    <div class="wfm-timeline">
      <div class="wfm-timeline-scroll">
        <div class="wfm-timeline-header">
          <div class="wfm-emp-col-header">Employee</div>
          <div class="wfm-hours" style="width:${dayCellPx * days.length}px">${days.map((d) => `<div class="wfm-hour-cell" style="width:${dayCellPx}px">${new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</div>`).join("")}</div>
        </div>
        <div class="wfm-body">${groupsHtml || `<div class="wfm-row"><div class="wfm-emp-cell muted">No employees in this org unit.</div></div>`}</div>
      </div>
    </div>`;
}

/* ---------- employee expansion ---------- */
async function loadLeaveTypes(state) {
  if (state.wf.leaveTypes) return;
  try {
    state.wf.leaveTypes = await LeaveApi.listLeaveTypes();
  } catch (err) {
    state.wf.leaveTypes = { error: errMsg(err) };
  }
  doRerender();
}

async function loadLeaveBalances(state, employeeId) {
  state.wf.leaveBalances = state.wf.leaveBalances || {};
  try {
    state.wf.leaveBalances[employeeId] = await LeaveApi.getEmployeeLeaveBalances(employeeId);
  } catch (err) {
    state.wf.leaveBalances[employeeId] = { error: errMsg(err) };
  }
  doRerender();
}

function renderEmployeeExpansion(state, e) {
  loadLeaveTypes(state);
  state.wf.leaveBalances = state.wf.leaveBalances || {};
  const balances = state.wf.leaveBalances[e.id];
  if (balances === undefined) loadLeaveBalances(state, e.id);
  const leaveTypes = isOk(state.wf.leaveTypes) ? state.wf.leaveTypes : [];
  const leaveTypeName = (id) => (leaveTypes.find((t) => t.id === id) || {}).name || id;

  return `<div class="cov" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:16px">
    <div><b>Identity</b>
      <div class="muted">ID: ${esc(e.employeeNumber)}</div>
      <div class="muted">Supervisor: ${e.managerEmployeeId ? esc(empLabel(state, e.manager || { employeeNumber: e.managerEmployeeId })) : "—"}</div>
      <div class="muted">Team Lead: ${e.teamLeadEmployeeId ? esc(empLabel(state, e.teamLead || { employeeNumber: e.teamLeadEmployeeId })) : "—"}</div>
      <div class="muted">Groups: ${e.groups && e.groups.length ? e.groups.map((g) => esc(g.name)).join(", ") : "—"}</div>
    </div>
    <div><b>Skills</b><div class="muted">See Employees &gt; Skills for full detail.</div></div>
    <div><b>Work rules</b><div class="muted">See Employees &gt; Work Rules for full detail.</div></div>
    <div><b>Time off</b>${
      !balances ? `<div class="muted">Loading…</div>`
      : !isOk(balances) ? `<div class="muted">${esc(balances.error)}</div>`
      : balances.map((b) => `<div class="muted">${esc(leaveTypeName(b.leaveTypeId))}: <b>${b.availableDays}</b> available</div>`).join("") || `<div class="muted">No balances recorded.</div>`
    }</div>
  </div>`;
}

/* ---------- activity detail drawer ---------- */
function renderActivityDrawer(state) {
  if (state.drawer !== "cal-activity") return "";
  const key = `${state.calOu}|${rangeDates(state).from}|${state.calRangeMode === "week" ? rangeDates(state).to : rangeDates(state).from}`;
  const rows = state.wf.calAssignments && state.wf.calAssignments[key];
  const a = isOk(rows) ? rows.find((x) => x.id === state.calActivityDetailId) : null;
  if (!a) return "";
  const roster = state.wf.calRoster && state.wf.calRoster[state.calOu];
  const emp = isOk(roster) ? roster.find((e) => e.id === a.employeeId) : null;
  return drawerShell("Shift assignment", "Real backend fields only",
    `<dl class="kv">
        <dt>Employee</dt><dd>${emp ? esc(empLabel(state, emp)) : esc(a.employeeId)}</dd>
        <dt>Start</dt><dd class="mono">${new Date(a.shiftStart).toLocaleString()}</dd>
        <dt>End</dt><dd class="mono">${new Date(a.shiftEnd).toLocaleString()}</dd>
        <dt>Duration</dt><dd>${((new Date(a.shiftEnd) - new Date(a.shiftStart)) / 3600000).toFixed(1)}h</dd>
        <dt>Skill</dt><dd>${a.skillId || "—"}</dd>
        <dt>Source</dt><dd>${esc(a.assignmentSource)}</dd>
        <dt>Overtime</dt><dd>${a.isOvertime ? "Yes" : "No"}</dd>
        <dt>Locked</dt><dd>${a.locked ? "Yes" : "No"}</dd>
        <dt>Schedule</dt><dd class="mono">${a.scheduleId ? a.scheduleId.slice(0, 8) + "…" : "—"}</dd>
        <dt>Published</dt><dd>${a.publishedAt ? fmtDt(a.publishedAt) : "—"}</dd>
      </dl>
      <p class="hint" style="margin-top:10px">No time-move/resize endpoint exists on the backend for a published assignment — only reassigning to a different employee (Mass Schedule Editor's Reassign action, on a still-unpublished schedule).</p>`,
    "", `<button class="btn" data-wf="close-drawer">Close</button>`);
}

/* ---------- Coverage view ---------- */
function renderCoverageView(state, groups, from) {
  const employees = groups.flatMap((g) => g.employees);
  const live = state.wf.calQueueLive && state.wf.calQueueLive[state.calOu];
  if (live === undefined) loadQueueLive(state, state.calOu);

  const key = `${state.calOu}|${from}|${from}`;
  const rows = state.wf.calAssignments && state.wf.calAssignments[key];
  if (rows === undefined) loadAssignments(state, key, employees.map((e) => e.id), `${from}T00:00:00Z`, `${addDays(from, 1)}T00:00:00Z`);

  let liveBody;
  if (!live) liveBody = `<div class="skel" style="height:24px"></div>`;
  else if (live.error) liveBody = `<p class="muted">No live coverage data for this org unit yet — nothing has published a queue metrics snapshot to it.</p>`;
  else liveBody = `<dl class="kv">
      <dt>Current volume</dt><dd>${live.currentVolume ?? "—"}</dd>
      <dt>Forecasted volume</dt><dd>${live.forecastedVolume ?? "—"}</dd>
      <dt>Agents available</dt><dd>${live.agentsAvailable ?? "—"}</dd>
      <dt>Agents on call</dt><dd>${live.agentsOnCall ?? "—"}</dd>
      <dt>Service level (current vs target)</dt><dd>${live.serviceLevelCurrent != null ? `${(live.serviceLevelCurrent * 100).toFixed(1)}%` : "—"} vs ${live.serviceLevelTarget != null ? `${(live.serviceLevelTarget * 100).toFixed(1)}%` : "—"}</dd>
      <dt>Data freshness</dt><dd>${live.dataFreshness.status}${live.dataFreshness.lastKnownUpdateAt ? ` — last known update ${fmtDt(live.dataFreshness.lastKnownUpdateAt)}` : ""}</dd>
    </dl>`;

  const forecastJob = state.wf.forecastJobs && state.wf.forecastJobs[state.calOu];
  let hourlyBody;
  if (!isOk(rows)) {
    hourlyBody = `<div class="skel" style="height:24px"></div>`;
  } else {
    let points = null;
    if (forecastJob && forecastJob.status === "completed") {
      state.wf.forecastDataPoints = state.wf.forecastDataPoints || {};
      points = state.wf.forecastDataPoints[forecastJob.id];
    }
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const dayStart = new Date(from + "T00:00:00Z");
    const scheduledByHour = hours.map((h) => {
      const hStart = new Date(dayStart.getTime() + h * 3600000);
      const hEnd = new Date(dayStart.getTime() + (h + 1) * 3600000);
      return rows.filter((a) => new Date(a.shiftStart) < hEnd && new Date(a.shiftEnd) > hStart).length;
    });
    const requiredByHour = hours.map((h) => {
      if (!isOk(points)) return null;
      const hStart = new Date(dayStart.getTime() + h * 3600000);
      const hEnd = new Date(dayStart.getTime() + (h + 1) * 3600000);
      const inHour = points.filter((p) => { const t = new Date(p.intervalStart); return t >= hStart && t < hEnd; });
      if (!inHour.length) return null;
      return Math.max(...inHour.map((p) => Number(p.requiredHeadcount ?? 0)));
    });
    const anyRequired = requiredByHour.some((v) => v != null);
    hourlyBody = `
      <table class="data"><thead><tr><th>Hour</th>${hours.map((h) => `<th>${String(h).padStart(2, "0")}</th>`).join("")}</tr></thead>
      <tbody>
        <tr><td>Required</td>${requiredByHour.map((v) => `<td class="mono">${v == null ? "—" : v}</td>`).join("")}</tr>
        <tr><td>Scheduled</td>${scheduledByHour.map((v) => `<td class="mono">${v}</td>`).join("")}</tr>
        <tr><td>Variance</td>${hours.map((h) => {
          const req = requiredByHour[h]; const sch = scheduledByHour[h];
          if (req == null) return `<td class="mono muted">—</td>`;
          const v = sch - req;
          return `<td class="mono" style="color:${v < 0 ? "var(--danger)" : v > 0 ? "var(--ok)" : "inherit"}">${v > 0 ? "+" : ""}${v}</td>`;
        }).join("")}</tr>
      </tbody></table>
      ${!anyRequired ? `<p class="hint">No completed Tactical Forecast run for this org unit this session, so "Required" can't be computed — run one under Forecasting &gt; Tactical Forecast. "Scheduled" is always real (derived from published shift assignments). "Actual" staffing per hour isn't shown: no backend endpoint returns historical per-interval staffing, only a live current-moment snapshot (see above).</p>` : `<p class="hint">"Actual" staffing per hour isn't shown: no backend endpoint returns historical per-interval staffing, only the live current-moment snapshot above.</p>`}
    `;
  }

  return `
    ${sec("Live queue state", liveBody)}
    ${sec(`Required vs scheduled — ${from}`, hourlyBody)}
  `;
}

/* ---------- Adherence view (list mode, alongside the grid overlay) ---------- */
function adherenceStatusBadge(status) {
  if (!status) return `<span class="badge badge-sys"><span class="pip"></span>No live data</span>`;
  const map = { adherent: ["badge-ok", "Adherent"], non_adherent: ["badge-danger", "Non-adherent"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

function exceptionStatusBadge(status) {
  const map = { open: ["badge-danger", "Open"], acknowledged: ["badge-warn", "Acknowledged"], resolved: ["badge-off", "Resolved"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

function renderAdherenceList(state, employees) {
  const key = state.calOu;
  const live = state.wf.calAgentLive && state.wf.calAgentLive[key];
  if (live === undefined) loadAgentLive(state, key, employees.map((e) => e.id));

  const rowsBody = !live
    ? `<div class="skel" style="height:24px"></div>`
    : live.error ? `<p class="muted">${esc(live.error)}</p>`
    : `<table class="data"><thead><tr><th>Employee</th><th>Scheduled activity</th><th>Current activity</th><th>Adherence</th><th></th></tr></thead><tbody>${
        employees.map((e, i) => {
          const s = live[i];
          return `<tr>
            <td>${esc(empLabel(state, e))}</td>
            <td>${s?.scheduledActivity ? esc(s.scheduledActivity) : "—"}</td>
            <td>${s?.currentActivity ? esc(s.currentActivity) : "—"}</td>
            <td>${adherenceStatusBadge(s?.adherenceStatus)}</td>
            <td><button class="btn btn-sm" data-wf="cal-exc-emp" data-id="${e.id}">Exceptions</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="5" class="muted">No employees in this org unit.</td></tr>`
      }</tbody></table>`;

  let excBody = "";
  if (state.calExcEmp) {
    const exceptions = state.wf.calExceptions && state.wf.calExceptions[state.calExcEmp];
    if (exceptions === undefined) loadExceptions(state, state.calExcEmp);
    const emp = employees.find((e) => e.id === state.calExcEmp);
    excBody = sec(`Adherence exceptions — ${emp ? esc(empLabel(state, emp)) : ""}`, !exceptions
      ? `<div class="skel" style="height:24px"></div>`
      : !isOk(exceptions) ? `<p class="muted">${esc(exceptions.error)}</p>`
      : `<table class="data"><thead><tr><th>Window</th><th>Actual</th><th>Scheduled</th><th>Deviation</th><th>Status</th><th></th></tr></thead><tbody>${
          exceptions.map((x) => `<tr>
            <td class="mono">${fmtTime(x.startedAt)}–${fmtTime(x.endedAt)}</td>
            <td>${esc(x.activity)}</td>
            <td>${x.scheduledActivity ? esc(x.scheduledActivity) : "—"}</td>
            <td class="mono">${Math.round(x.deviationSeconds / 60)} min</td>
            <td>${exceptionStatusBadge(x.status)}</td>
            <td>${x.status === "open" ? `<button class="btn btn-sm" data-wf="cal-exc-ack" data-id="${x.id}">Acknowledge</button>` : x.status === "acknowledged" ? `<button class="btn btn-sm" data-wf="cal-exc-resolve" data-id="${x.id}">Resolve</button>` : ""}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="muted">No exceptions recorded for this employee.</td></tr>`
        }</tbody></table>`);
  }

  return `${sec("Live adherence (current moment)", rowsBody)}${excBody}<p class="hint">The timeline above overlays each employee's real Adherence Exception segments (⚠) — the only backend record of actual, timestamped non-adherent activity. A full planned-vs-actual activity stream isn't available: the raw event log (AdherenceEvent) is never exposed by any API.</p>`;
}

/* ---------- summary cards ---------- */
function renderSummary(state, employees, from) {
  const key = `${state.calOu}|${from}|${state.calRangeMode === "week" ? rangeDates(state).to : from}`;
  const rows = state.wf.calAssignments && state.wf.calAssignments[key];
  const now = new Date();
  const scheduledCount = isOk(rows) ? new Set(rows.map((a) => a.employeeId)).size : null;
  const workingNow = isOk(rows) ? rows.filter((a) => new Date(a.shiftStart) <= now && new Date(a.shiftEnd) >= now).length : null;
  const leave = state.wf.calLeave && state.wf.calLeave[state.calOu];
  const onLeaveToday = isOk(leave) ? leave.filter((r) => r.dateRangeStart <= from && r.dateRangeEnd >= from).length : null;
  const live = state.wf.calAgentLive && state.wf.calAgentLive[state.calOu];
  const adherencePct = isOk(live) && live.length
    ? Math.round((live.filter((s) => s?.adherenceStatus === "adherent").length / live.filter((s) => s?.adherenceStatus).length || 0) * 100)
    : null;
  const hasAdherenceSignal = isOk(live) && live.some((s) => s?.adherenceStatus);

  const card = (n, l) => `<div><div class="n">${n == null ? "—" : n}</div><div class="l">${l}</div></div>`;
  return `<div class="summary" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
    ${card(scheduledCount, "Scheduled today")}
    ${card(workingNow, "Working now")}
    ${card(onLeaveToday, "On time off")}
    ${card(hasAdherenceSignal ? `${adherencePct}%` : "—", "Adherence (live)")}
  </div>`;
}

/* ---------- top-level render ---------- */
export function render(state) {
  initDefaults(state);
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.calOu === undefined && orgUnits.length) state.calOu = orgUnits[0].id;

  if (!orgUnits.length) {
    return `${pageHead("Calendar", "Employees vertically, time horizontally, scheduled activities as blocks.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  loadUsers(state);
  state.wf.calOuTz = state.wf.calOuTz || {};
  if (state.wf.calOuTz[state.calOu] === undefined) loadOuTimezone(state, state.calOu);

  state.wf.calRoster = state.wf.calRoster || {};
  const employeesRaw = state.wf.calRoster[state.calOu];
  if (employeesRaw === undefined) loadRosterEmployees(state, state.calOu);
  const empList = isOk(employeesRaw) ? filterBySearch(employeesRaw, state, state.calSearch) : [];
  const groups = buildGroups(state, empList);
  const { from, to } = rangeDates(state);

  let viewBody;
  if (!employeesRaw) viewBody = `<div class="skel" style="height:24px"></div>`;
  else if (!isOk(employeesRaw)) viewBody = `<p class="muted">${esc(employeesRaw.error)}</p>`;
  else if (state.calViewMode === "coverage") viewBody = renderCoverageView(state, groups, from);
  else {
    const grid = state.calRangeMode === "week" ? renderWeekGrid(state, groups, from, to) : renderDayGrid(state, groups, from);
    const adherenceExtra = state.calViewMode === "adherence" ? renderAdherenceList(state, empList) : "";
    viewBody = grid + adherenceExtra;
  }

  const zoomPct = state.calZoom;
  return `
    ${pageHead("Calendar", "Employees vertically, time horizontally, scheduled activities as blocks.", "")}
    <div class="grid-2" style="margin-bottom:10px;align-items:end">
      <div class="field"><label>Org unit</label><select data-wf="cal-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.calOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Group by</label><select data-wf="cal-groupby">
        <option value="none" ${state.calGroupBy === "none" ? "selected" : ""}>None</option>
        <option value="supervisor" ${state.calGroupBy === "supervisor" ? "selected" : ""}>Supervisor</option>
        <option value="teamlead" ${state.calGroupBy === "teamlead" ? "selected" : ""}>Team Lead</option>
        <option value="group" ${state.calGroupBy === "group" ? "selected" : ""}>Group</option>
      </select></div>
      <div class="field"><label>Search employees</label><input data-wf="cal-search" value="${esc(state.calSearch)}" placeholder="Name or employee number" /></div>
      <div class="field"><label>&nbsp;</label>
        <div class="tabs">
          <button class="tab ${state.calViewMode === "schedule" ? "on" : ""}" data-wf="cal-mode" data-id="schedule">Schedule</button>
          <button class="tab ${state.calViewMode === "adherence" ? "on" : ""}" data-wf="cal-mode" data-id="adherence">Adherence</button>
          <button class="tab ${state.calViewMode === "coverage" ? "on" : ""}" data-wf="cal-mode" data-id="coverage">Coverage</button>
        </div>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:14px;align-items:end">
      <div class="field"><label>&nbsp;</label>
        <div class="tabs">
          <button class="tab ${state.calRangeMode === "day" ? "on" : ""}" data-wf="cal-range-mode" data-id="day">Day</button>
          <button class="tab ${state.calRangeMode === "week" ? "on" : ""}" data-wf="cal-range-mode" data-id="week">Week</button>
        </div>
      </div>
      <div class="field"><label>Date</label><div style="display:flex;gap:4px;align-items:center">
        <button class="btn btn-sm" data-wf="cal-nav" data-id="prev">‹</button>
        <input type="date" data-wf="cal-from" value="${state.calFrom}" style="flex:1" />
        <button class="btn btn-sm" data-wf="cal-nav" data-id="next">›</button>
        <button class="btn btn-sm" data-wf="cal-nav" data-id="today">Today</button>
      </div></div>
      ${state.calRangeMode === "day" ? `<div class="field"><label>Zoom</label><div style="display:flex;gap:4px;align-items:center">
        <button class="btn btn-sm" data-wf="cal-zoom" data-id="out">−</button>
        <span class="mono" style="min-width:44px;text-align:center">${zoomPct}%</span>
        <button class="btn btn-sm" data-wf="cal-zoom" data-id="in">+</button>
      </div></div>` : "<div></div>"}
      <div></div>
    </div>
    ${employeesRaw && isOk(employeesRaw) ? renderSummary(state, empList, from) : ""}
    ${viewBody}
    ${renderActivityDrawer(state)}`;
}

export function handle(state, act, id, value) {
  if (act === "cal-ou") { state.calOu = value; state.calGroupCollapsed = new Set(); return true; }
  if (act === "cal-mode") { state.calViewMode = id; state.calExcEmp = null; return true; }
  if (act === "cal-range-mode") { state.calRangeMode = id; return true; }
  if (act === "cal-groupby") { state.calGroupBy = value; state.calGroupCollapsed = new Set(); return true; }
  if (act === "cal-search") { state.calSearch = value; return true; }
  if (act === "cal-group-toggle") {
    if (state.calGroupCollapsed.has(id)) state.calGroupCollapsed.delete(id);
    else state.calGroupCollapsed.add(id);
    return true;
  }
  if (act === "cal-from") { state.calFrom = value; return true; }
  if (act === "cal-nav") {
    if (id === "today") state.calFrom = isoDate(new Date());
    else if (id === "prev") state.calFrom = addDays(state.calFrom, state.calRangeMode === "week" ? -7 : -1);
    else if (id === "next") state.calFrom = addDays(state.calFrom, state.calRangeMode === "week" ? 7 : 1);
    return true;
  }
  if (act === "cal-zoom") {
    if (id === "in") state.calZoom = Math.min(300, state.calZoom + 25);
    else state.calZoom = Math.max(50, state.calZoom - 25);
    return true;
  }
  if (act === "cal-week-day") { state.calFrom = id; state.calRangeMode = "day"; return true; }
  if (act === "cal-activity") { state.calActivityDetailId = id; state.drawer = "cal-activity"; return true; }
  if (act === "cal-toggle-emp") {
    state.calExpanded = state.calExpanded || new Set();
    if (state.calExpanded.has(id)) state.calExpanded.delete(id);
    else state.calExpanded.add(id);
    return true;
  }
  if (act === "cal-exc-emp") { state.calExcEmp = state.calExcEmp === id ? null : id; return true; }
  if (act === "cal-exc-ack") {
    IntradayApi.acknowledgeAdherenceException(id)
      .then(() => { state.wf.calExceptions[state.calExcEmp] = null; toast("Exception acknowledged."); doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "cal-exc-resolve") {
    const notes = prompt("Resolution notes:");
    if (!notes) return true;
    IntradayApi.resolveAdherenceException(id, notes)
      .then(() => { state.wf.calExceptions[state.calExcEmp] = null; toast("Exception resolved."); doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
