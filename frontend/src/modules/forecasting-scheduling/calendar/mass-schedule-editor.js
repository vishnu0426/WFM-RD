/* Mass Schedule Editor — submit a new schedule solve job, then view/edit
   the resulting schedule: override individual assignments (with real
   backend double-booking conflict detection), view conflicts, publish.

   Scope note: a schedule can't be created without a completed Tactical
   Forecast run for the same org unit (forecastRunId is required, no
   default — ScheduleJobRequest's own schema) — this screen cross-
   references forecast jobs submitted this session (Forecasting > Tactical
   Forecast) rather than requiring a pasted UUID.

   Reoptimize needs a full EmploymentPolicyInput plus every shift slot the
   current schedule occupies plus a real employee roster (contract hours
   per week — a real Employee field, not invented). The policy form can
   prefill from an existing Project Rule; shift slots and the roster are
   reconstructed from the schedule already on screen (real assignment data,
   not fabricated) — no employee-skill/preference data is attached since
   that's an optional field this screen doesn't have a source for yet. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { Api } from '../../../core/api.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as SchedulingApi from '../../scheduling/api.js';

const isOk = (x) => Array.isArray(x);

function statusBadge(s) {
  const map = { queued: ["badge-warn", "Queued"], solving: ["badge-warn", "Solving"], completed: ["badge-ok", "Completed"], failed: ["badge-danger", "Failed"] };
  const [c, l] = map[s] || ["badge-sys", s];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

async function loadTemplates(state) {
  if (state.wf.shiftTemplates) return;
  try {
    state.wf.shiftTemplates = await SchedulingApi.listShiftTemplates();
  } catch (err) {
    state.wf.shiftTemplates = { error: errMsg(err) };
  }
  doRerender();
}

async function loadProjectRules(state) {
  if (state.wf.projectRules) return;
  try {
    state.wf.projectRules = await SchedulingApi.listProjectRules();
  } catch (err) {
    state.wf.projectRules = { error: errMsg(err) };
  }
  doRerender();
}

async function loadJobHistory(state, orgUnitId) {
  state.wf.scheduleJobHistory = state.wf.scheduleJobHistory || {};
  try {
    state.wf.scheduleJobHistory[orgUnitId] = await SchedulingApi.listScheduleJobs(orgUnitId);
  } catch (err) {
    state.wf.scheduleJobHistory[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

async function pollJob(state) {
  try {
    const job = await SchedulingApi.getScheduleJob(state.mse.jobId);
    state.mse.jobStatus = job.status;
    if (job.status === "completed") await loadSchedule(state);
    else if (job.status === "failed") toast("Schedule solve failed.");
  } catch (err) {
    toast(errMsg(err));
  }
  doRerender();
}

async function loadSchedule(state) {
  try {
    state.mse.schedule = await SchedulingApi.getScheduleJobSchedule(state.mse.jobId);
    await loadConflicts(state);
  } catch (err) {
    toast(errMsg(err));
  }
  doRerender();
}

async function loadConflicts(state) {
  try {
    state.mse.conflicts = await SchedulingApi.listScheduleConflicts(state.mse.schedule.id);
  } catch (err) {
    state.mse.conflicts = { error: errMsg(err) };
  }
  doRerender();
}

function generateShiftSlots(templates, templateIds, from, to) {
  const slots = [];
  let d = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  while (d <= end) {
    const dateStr = d.toISOString().slice(0, 10);
    templateIds.forEach((tid) => {
      const t = templates.find((x) => x.id === tid);
      if (!t) return;
      slots.push({
        id: crypto.randomUUID(),
        start: `${dateStr}T${t.startTime}:00`,
        end: `${dateStr}T${t.endTime}:00`,
        breakMinutes: t.breakMinutes,
      });
    });
    d.setDate(d.getDate() + 1);
  }
  return slots;
}

export function render(state) {
  state.mse = state.mse || { jobId: null, jobStatus: null, schedule: null, conflicts: null };
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.mseOu === undefined && orgUnits.length) state.mseOu = orgUnits[0].id;
  loadTemplates(state);
  const templates = isOk(state.wf.shiftTemplates) ? state.wf.shiftTemplates : [];

  if (!orgUnits.length) {
    return `${pageHead("Mass Schedule Editor", "Submit a schedule solve, then review and adjust its assignments.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  const forecastJobsForOu = state.wf.forecastJobs && state.wf.forecastJobs[state.mseOu] && state.wf.forecastJobs[state.mseOu].status === "completed"
    ? [state.wf.forecastJobs[state.mseOu]] : [];

  const today = new Date().toISOString().slice(0, 10);
  const weekOut = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  state.wf.scheduleJobHistory = state.wf.scheduleJobHistory || {};
  const history = state.wf.scheduleJobHistory[state.mseOu];
  if (history === undefined) loadJobHistory(state, state.mseOu);
  const historyBody = !history
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(history) ? `<p class="muted">${esc(history.error)}</p>`
    : `<table class="data"><thead><tr><th>Requested</th><th>Range</th><th>Status</th><th></th></tr></thead><tbody>${
        history.map((h) => `<tr>
          <td class="muted">${new Date(h.requestedAt).toLocaleString()}</td>
          <td class="mono">${h.dateRange.start} – ${h.dateRange.end}</td>
          <td>${statusBadge(h.status)}</td>
          <td><button class="btn btn-sm" data-wf="mse-load-job" data-id="${h.id}">View</button></td>
        </tr>`).join("") || `<tr><td colspan="4" class="muted">No solves recorded yet for this org unit.</td></tr>`
      }</tbody></table>`;

  let resultSection = "";
  if (state.mse.jobId) {
    resultSection = sec("Solve result", `
      <div style="margin-bottom:10px">${statusBadge(state.mse.jobStatus)} ${state.mse.jobStatus !== "completed" && state.mse.jobStatus !== "failed" ? `<button class="btn btn-sm" data-wf="mse-poll">Refresh status</button>` : ""}</div>
      ${state.mse.schedule ? renderSchedule(state) : ""}
    `);
  }

  return `
    ${pageHead("Mass Schedule Editor", "Submit a schedule solve, then review and adjust its assignments.", "")}
    ${sec("Submit schedule solve", `
      <div class="grid-2">
        <div class="field"><label>Org unit</label><select id="mse-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.mseOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Forecast run</label>
          ${forecastJobsForOu.length
            ? `<select id="mse-forecast">${forecastJobsForOu.map((j) => `<option value="${j.id}">Completed run ${j.id.slice(0, 8)}… (this session)</option>`).join("")}</select>`
            : `<input id="mse-forecast-manual" placeholder="Paste a completed forecast run id (UUID)" />`}
        </div>
        <div class="field"><label>From</label><input id="mse-start" type="date" value="${today}" /></div>
        <div class="field"><label>To</label><input id="mse-end" type="date" value="${weekOut}" /></div>
        <div class="field full"><label>Shift templates to schedule (one instance per day in range)</label>
          ${templates.length
            ? templates.map((t) => `<label style="display:inline-block;margin-right:14px"><input type="checkbox" class="mse-template" value="${t.id}" style="width:auto;margin-right:4px" />${esc(t.name)} (${t.startTime}–${t.endTime})</label>`).join("")
            : `<p class="hint">No shift templates yet — create one under Scenarios &gt; Staffing Profiles &gt; Shift Templates first.</p>`}
        </div>
      </div>
      ${!forecastJobsForOu.length ? `<p class="hint">No completed Tactical Forecast run for this org unit this session — run one under Forecasting &gt; Tactical Forecast first, or paste a known forecast run id.</p>` : ""}
      <div class="actions" style="margin-top:10px"><button class="btn btn-primary" data-wf="mse-submit" ${state.wf.saving.mse ? "disabled" : ""}>${state.wf.saving.mse ? "Submitting…" : "Submit solve"}</button></div>
    `)}
    ${sec("Recent solves", historyBody)}
    ${resultSection}`;
}

function conflictStatusBadge(status) {
  const map = { open: ["badge-danger", "Open"], acknowledged: ["badge-warn", "Acknowledged"], resolved: ["badge-off", "Resolved"] };
  const [c, l] = map[status] || ["badge-sys", status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

function renderSchedule(state) {
  const s = state.mse.schedule;
  const conflicts = state.mse.conflicts;
  return `
    <div style="margin:10px 0"><b>Schedule ${s.id.slice(0, 8)}…</b> — ${s.publishedAt ? `published` : `draft`}
      ${!s.publishedAt ? `<button class="btn btn-sm" data-wf="mse-publish" style="margin-left:8px">Publish</button>` : ""}
    </div>
    <table class="data"><thead><tr><th>Employee</th><th>Shift</th><th>Skill</th><th>Source</th><th>OT</th><th>Locked</th><th></th></tr></thead><tbody>${
      s.assignments.map((a) => `<tr>
        <td class="mono">${a.employeeId.slice(0, 8)}…</td>
        <td class="mono">${new Date(a.shiftStart).toLocaleString()} – ${new Date(a.shiftEnd).toLocaleTimeString()}</td>
        <td>${a.skillId ? a.skillId.slice(0, 8) + "…" : "—"}</td>
        <td class="muted">${a.assignmentSource}</td>
        <td>${a.isOvertime ? "Yes" : "No"}</td>
        <td>${a.locked ? "Yes" : "No"}</td>
        <td>${!a.locked ? `<button class="btn btn-sm" data-wf="mse-override" data-id="${a.id}">Reassign</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="muted">No assignments — the solve produced an empty schedule.</td></tr>`
    }</tbody></table>
    ${sec("Conflicts", !conflicts
      ? `<div class="skel" style="height:24px"></div>`
      : conflicts.error ? `<p class="muted">${esc(conflicts.error)}</p>`
      : conflicts.length
        ? `<table class="data"><thead><tr><th>Type</th><th>Employee</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${
            conflicts.map((c) => `<tr>
              <td>${esc(c.conflictType)}</td>
              <td class="mono">${c.affectedEmployeeId.slice(0, 8)}…</td>
              <td>${conflictStatusBadge(c.status)}</td>
              <td class="muted">${new Date(c.createdAt).toLocaleString()}</td>
              <td>${c.status === "open" ? `<button class="btn btn-sm" data-wf="mse-conflict-ack" data-id="${c.id}">Acknowledge</button>` : c.status === "acknowledged" ? `<button class="btn btn-sm" data-wf="mse-conflict-resolve" data-id="${c.id}">Resolve</button>` : ""}</td>
            </tr>`).join("")
          }</tbody></table>`
        : `<p class="muted">No conflicts detected.</p>`)}
    ${renderReoptimize(state)}
  `;
}

function renderReoptimize(state) {
  loadProjectRules(state);
  const rules = isOk(state.wf.projectRules) ? state.wf.projectRules : [];
  const r = state.mse.reoptPolicyFrom ? rules.find((x) => x.id === state.mse.reoptPolicyFrom) : null;
  return sec("Reoptimize", `
    <p class="hint">Re-solves this schedule against a fresh policy — reconstructs shift slots and roster (contract hours) from the schedule shown above.</p>
    <div class="field"><label>Prefill policy from a Project Rule (optional)</label>
      <select data-wf="mse-reopt-policy-from"><option value="">— manual —</option>${rules.map((x) => `<option value="${x.id}" ${x.id === state.mse.reoptPolicyFrom ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Max consecutive working days</label><input id="reopt-maxdays" type="number" min="1" value="${r ? r.maxConsecutiveWorkingDays : 6}" /></div>
      <div class="field"><label>Min rest hours between shifts</label><input id="reopt-minrest" type="number" min="0" step="0.5" value="${r ? r.minRestHoursBetweenShifts : 10}" /></div>
      <div class="field"><label>Min shift length (minutes)</label><input id="reopt-minlen" type="number" min="1" value="${r ? r.minShiftLengthMinutes : 240}" /></div>
      <div class="field"><label>Max shift length (minutes, optional)</label><input id="reopt-maxlen" type="number" min="1" value="${r && r.maxShiftLengthMinutes != null ? r.maxShiftLengthMinutes : ""}" /></div>
      <div class="field"><label>Mandatory break after (hours, optional)</label><input id="reopt-breakafter" type="number" min="0" step="0.5" /></div>
      <div class="field"><label>Mandatory break (minutes, optional)</label><input id="reopt-breakmin" type="number" min="0" /></div>
    </div>
    <div class="actions" style="margin-top:10px"><button class="btn btn-primary" data-wf="mse-reoptimize" ${state.wf.saving.reopt ? "disabled" : ""}>${state.wf.saving.reopt ? "Submitting…" : "Reoptimize"}</button></div>
  `);
}

async function buildReoptimizePayload(state) {
  const s = state.mse.schedule;
  const shiftSlots = s.assignments.map((a) => ({
    id: crypto.randomUUID(),
    start: a.shiftStart,
    end: a.shiftEnd,
    requiredSkillId: a.skillId || undefined,
    orgUnitId: state.mseOu,
  }));
  const employeeIds = [...new Set(s.assignments.map((a) => a.employeeId))];
  let roster = [];
  if (employeeIds.length) {
    const query = `query(${employeeIds.map((_, i) => `$e${i}: ID!`).join(', ')}) {
      ${employeeIds.map((_, i) => `e${i}: employee(id: $e${i}) { id contractHoursPerWeek }`).join('\n')}
    }`;
    const variables = Object.fromEntries(employeeIds.map((eid, i) => [`e${i}`, eid]));
    const data = await Api.gqlFetch(query, variables);
    const missing = employeeIds.filter((eid, i) => !data[`e${i}`]);
    if (missing.length) {
      throw new Error(`Could not load contract hours for ${missing.length} employee(s) on this schedule — cannot build a real roster for reoptimize.`);
    }
    roster = employeeIds.map((eid, i) => ({ id: eid, contractHoursPerWeek: Number(data[`e${i}`].contractHoursPerWeek), orgUnitId: state.mseOu }));
  }
  return { shiftSlots, roster };
}

export function handle(state, act, id, value) {
  state.mse = state.mse || { jobId: null, jobStatus: null, schedule: null, conflicts: null };

  if (act === "mse-submit") {
    const orgUnitId = $("#mse-ou")?.value;
    const forecastRunId = $("#mse-forecast")?.value || $("#mse-forecast-manual")?.value.trim();
    const start = $("#mse-start")?.value;
    const end = $("#mse-end")?.value;
    const templateIds = [...document.querySelectorAll(".mse-template:checked")].map((el) => el.value);
    if (!forecastRunId) { toast("A completed forecast run id is required."); return true; }
    if (!start || !end) { toast("Both dates are required."); return true; }
    state.mseOu = orgUnitId;
    const templates = isOk(state.wf.shiftTemplates) ? state.wf.shiftTemplates : [];
    const shiftSlots = generateShiftSlots(templates, templateIds, start, end);
    state.wf.saving.mse = true;
    doRerender();
    SchedulingApi.submitScheduleJob({ orgUnitId, dateRange: { start, end }, forecastRunId, shiftSlots })
      .then((resp) => {
        state.wf.saving.mse = false;
        state.mse = { jobId: resp.jobId, jobStatus: resp.status, schedule: null, conflicts: null };
        if (state.wf.scheduleJobHistory) delete state.wf.scheduleJobHistory[orgUnitId];
        toast(resp.status === "completed" ? "Solve completed." : "Solve queued.");
        if (resp.status === "completed") loadSchedule(state);
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.mse = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "mse-poll") { pollJob(state); return true; }

  if (act === "mse-load-job") {
    state.mse = { jobId: id, jobStatus: null, schedule: null, conflicts: null };
    pollJob(state);
    return true;
  }

  if (act === "mse-conflict-ack") {
    SchedulingApi.resolveScheduleConflict(state.mse.schedule.id, id, "acknowledged")
      .then(() => { toast("Conflict acknowledged."); loadConflicts(state); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "mse-conflict-resolve") {
    SchedulingApi.resolveScheduleConflict(state.mse.schedule.id, id, "resolved")
      .then(() => { toast("Conflict resolved."); loadConflicts(state); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "mse-reopt-policy-from") {
    state.mse.reoptPolicyFrom = value || null;
    return true;
  }

  if (act === "mse-reoptimize") {
    const policy = {
      maxConsecutiveWorkingDays: Number($("#reopt-maxdays")?.value || 0),
      minRestHoursBetweenShifts: Number($("#reopt-minrest")?.value || 0),
      minShiftLengthMinutes: Number($("#reopt-minlen")?.value || 0),
      maxShiftLengthMinutes: $("#reopt-maxlen")?.value ? Number($("#reopt-maxlen").value) : undefined,
      mandatoryBreakAfterHours: $("#reopt-breakafter")?.value ? Number($("#reopt-breakafter").value) : undefined,
      mandatoryBreakMinutes: $("#reopt-breakmin")?.value ? Number($("#reopt-breakmin").value) : undefined,
    };
    if (!policy.maxConsecutiveWorkingDays || !policy.minShiftLengthMinutes) {
      toast("Max consecutive days and min shift length must be greater than 0.");
      return true;
    }
    state.wf.saving.reopt = true;
    doRerender();
    buildReoptimizePayload(state)
      .then(({ shiftSlots, roster }) => {
        if (!shiftSlots.length) throw new Error("This schedule has no assignments to reoptimize.");
        return SchedulingApi.reoptimizeSchedule(state.mse.schedule.id, { policy, roster, shiftSlots });
      })
      .then((resp) => {
        state.wf.saving.reopt = false;
        state.mse = { jobId: resp.jobId, jobStatus: resp.status, schedule: null, conflicts: null };
        if (state.wf.scheduleJobHistory) delete state.wf.scheduleJobHistory[state.mseOu];
        toast("Reoptimize submitted — solving.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.reopt = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "mse-override") {
    const employeeId = prompt("Reassign to employee id (UUID):");
    if (!employeeId) return true;
    SchedulingApi.overrideAssignment(state.mse.schedule.id, id, employeeId)
      .then(() => { toast("Assignment reassigned."); loadSchedule(state); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "mse-publish") {
    SchedulingApi.publishSchedule(state.mse.schedule.id)
      .then((updated) => { state.mse.schedule = updated; toast("Schedule published."); doRerender(); })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
