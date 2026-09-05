/* Profiles — employee list + detail/edit view. Employee has no name column
   of its own; display name comes from the linked User (see empName in
   shared/employee-helpers.js). Wired to GraphQL employee CRUD + transferEmployee
   + POST /v1/employees/:id/avatar. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, typeLabel, drawerShell } from '../shared/ui.js';
import { empById, userFor, empName, empLabel, realOrgName } from '../shared/employee-helpers.js';
import { loadEmployees, loadUsers, loadOrgUnits, loadEmployeeDetail, loadEmployeesPage, EMPLOYEE_PAGE_SIZE } from '../shared/loaders.js';
import { listAcdConnectors } from '../../integration-hub/api.js';

/** Profiles list column — compact by design (don't overcrowd the list with every row): first source + agent id, "+N" for the rest, full detail lives on the Workforce / External Identity tab. */
function dataSourcesSummary(e) {
  const rows = e.dataSources || [];
  if (!rows.length) return "—";
  const first = `${esc(rows[0].dataSource)}${rows[0].agentId ? ` · <span class="mono">${esc(rows[0].agentId)}</span>` : ""}`;
  return rows.length > 1 ? `${first} <span class="muted">+${rows.length - 1}</span>` : first;
}

async function loadAcdConnectors(state) {
  if (state.wf.acdConnectors) return state.wf.acdConnectors;
  try {
    state.wf.acdConnectors = await listAcdConnectors();
  } catch {
    state.wf.acdConnectors = []; // integration-hub-service unreachable/not running locally — fall back to free text only
  }
  doRerender();
  return state.wf.acdConnectors;
}

export function render(state) {
  if (state.screen === "emp-detail") return empDetail(state);
  return profiles(state);
}

function profiles(state) {
  if (!state.wf.employees || !state.wf.users) {
    loadEmployees(state);
    loadUsers(state);
    loadOrgUnits(state);
    return pageHead("Profiles", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  state.empPage = state.empPage || 0;
  loadEmployeesPage(state);
  const page = state.wf.employeesPage;
  const total = state.wf.employeesTotal || 0;
  const q = (state.empSearch || "").toLowerCase();
  const f = state.empFilter;
  const pageRows = Array.isArray(page) ? page : [];
  const rows = q
    ? pageRows.filter((e) => {
        const name = empName(state, e) || "";
        const dsText = (e.dataSources || []).map((d) => `${d.dataSource} ${d.agentId || ""} ${d.extension || ""}`).join(" ");
        return `${e.employeeNumber} ${name} ${e.jobTitle || ""} ${dsText}`.toLowerCase().includes(q);
      })
    : pageRows;
  const orgOptions = state.data.orgUnits || [];
  const lastPage = Math.max(0, Math.ceil(total / EMPLOYEE_PAGE_SIZE) - 1);
  const rangeStart = total === 0 ? 0 : state.empPage * EMPLOYEE_PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (state.empPage + 1) * EMPLOYEE_PAGE_SIZE);
  return `
    ${pageHead("Profiles", "Personnel records. Distinct from User. employeeNumber is the primary identifier.", `
      <button class="btn" data-wf="export-employees">Export</button>
      <button class="btn" data-wf="toast" data-msg="Bulk HRIS import lives at /bulk-import — not a UM nav item.">Import</button>
      <button class="btn btn-primary" data-wf="open-add-emp">+ Create employee</button>`)}
    <div class="toolbar">
      <label class="search"><span>⌕</span><input data-wf="emp-search" value="${esc(state.empSearch)}" placeholder="Employee number, name, title, data source, agent ID, extension" /></label>
      <select data-wf="emp-st">${[["", "Any status"], ["ACTIVE", "Active"], ["ON_LEAVE", "On leave"], ["PENDING_ONBOARDING", "Pending"], ["TERMINATED", "Terminated"]].map(([v, l]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select data-wf="emp-ty">${[["", "Any type"], ["FULL_TIME", "Full time"], ["PART_TIME", "Part time"], ["CONTRACTOR", "Contractor"], ["SEASONAL", "Seasonal"]].map(([v, l]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select data-wf="emp-ou"><option value="">Any org unit</option>${orgOptions.map((o) => `<option value="${o.id}" ${f.ou === o.id ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
      <span class="meta">${total} total · employeesCount(filter)</span>
    </div>
    <div class="panel">
      ${!Array.isArray(page) ? `<div style="padding:16px"><div class="skel" style="height:24px"></div></div>` : `
      <table class="data" aria-label="Employees">
        <thead><tr><th>Employee</th><th>Number</th><th>Job title</th><th>Organization</th><th>Supervisor</th><th>Team Lead</th><th>Type</th><th>Status</th><th>Start</th><th>Data source</th></tr></thead>
        <tbody>${rows.map((e) => {
          const name = empName(state, e);
          const mgr = e.managerEmployeeId ? empById(state, e.managerEmployeeId) : null;
          const lead = e.teamLeadEmployeeId ? empById(state, e.teamLeadEmployeeId) : null;
          return `<tr>
          <td><a class="row-link" href="#" data-wf="open-emp" data-id="${e.id}">${name ? esc(name) : `<span class="muted">No name on Employee</span>`}</a></td>
          <td class="mono">${esc(e.employeeNumber)}</td>
          <td>${esc(e.jobTitle || "—")}</td>
          <td>${esc(realOrgName(state, e.orgUnitId))}</td>
          <td>${mgr ? esc(empLabel(state, mgr)) : "—"}</td>
          <td>${lead ? esc(empLabel(state, lead)) : "—"}</td>
          <td>${typeLabel(e.employmentType)}</td>
          <td>${stBadge(e.status)}</td>
          <td class="mono">${esc(e.hireDate)}</td>
          <td>${dataSourcesSummary(e)}</td>
        </tr>`;
        }).join("")}</tbody>
      </table>
      ${rows.length === 0 ? empty("No employees found.", "Create an employee, clear filters, or clear the search box.", `<button class="btn btn-primary" data-wf="open-add-emp">Create employee</button>`) : ""}
      `}
    </div>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn btn-sm" data-wf="emp-page-prev" ${state.empPage === 0 ? "disabled" : ""}>← Previous</button>
      <span class="meta">${total === 0 ? "0 results" : `Showing ${rangeStart}–${rangeEnd} of ${total}`}</span>
      <button class="btn btn-sm" data-wf="emp-page-next" ${state.empPage >= lastPage ? "disabled" : ""}>Next →</button>
    </div>
    <p class="hint">Status/type/org-unit filters run server-side (employees(filter, pagination)); search only applies to the ${EMPLOYEE_PAGE_SIZE} rows on the current page — clear it to page through everyone. Supervisor = managerEmployeeId. Team Lead = teamLeadEmployeeId. They are not the same field.</p>`;
}

function empDetail(state) {
  const id = state.empId;
  if (!id) return profiles(state);
  if (!(id in state.wf.employeeDetail)) loadEmployeeDetail(state, id);
  const e = state.wf.employeeDetail[id];
  if (e === undefined) {
    return pageHead("Loading…", "", `<button class="btn" data-wf="tab" data-id="profiles">Back</button>`) + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (e.error) {
    return pageHead("Failed to load employee", e.error, `<button class="btn" data-wf="tab" data-id="profiles">Back</button>`);
  }
  const tabs = [
    ["personal", "Personal"],
    ["contact", "Contact"],
    ["address", "Home address"],
    ["admin", "Employment"],
    ["org", "Organization"],
    ["agent", "Workforce / External Identity"],
  ];
  const t = state.empTab;
  const saveBtn = `<button class="btn btn-primary" data-wf="save-emp" data-id="${e.id}" data-tab="${t}" ${state.wf.saving.emp ? "disabled" : ""}>${state.wf.saving.emp ? "Saving…" : "Save"}</button>`;
  let body = "";
  if (t === "personal") {
    const u = e.userId ? userFor(state, e.userId) : null;
    const linkedIds = new Set((state.wf.employees || []).filter((x) => x.id !== e.id).map((x) => x.userId).filter(Boolean));
    const linkableUsers = (state.wf.users || []).filter((x) => !linkedIds.has(x.id));
    body = sec("Personal information", `
      <div class="callout" style="margin-bottom:12px">Employee has no name column of its own — the display name shown above comes entirely from the linked User account. Change or remove the link below.</div>
      <div class="field"><label>Linked user</label><select id="pe-user"><option value="">— Headcount only, no name —</option>${linkableUsers.map((x) => `<option value="${x.id}" ${e.userId === x.id ? "selected" : ""}>${esc(`${x.givenName || ""} ${x.familyName || ""}`.trim() || x.email)} · ${esc(x.email)}</option>`).join("")}</select>
        ${u ? `<span class="muted" style="margin-left:8px">Currently: ${esc(`${u.givenName || ""} ${u.familyName || ""}`.trim() || u.email)}</span>` : ""}
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Middle initial</label><input id="pe-mi" value="${esc(e.middleInitial || "")}" maxlength="10" /></div>
        <div class="field"><label>Suffix</label><input id="pe-suffix" value="${esc(e.suffix || "")}" maxlength="20" /></div>
        <div class="field"><label>Birth date</label><input id="pe-birth" type="date" value="${esc(e.birthDate || "")}" /></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Photo</label>
        ${e.avatarUrl ? `<img src="${esc(e.avatarUrl)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px" />` : ""}
        <input type="file" id="avatar-input-${e.id}" accept="image/png,image/jpeg,image/webp" style="display:inline-block" />
        <button class="btn btn-sm" data-wf="upload-avatar" data-id="${e.id}">Upload</button>
      </div>
      <div class="actions" style="margin-top:14px">${saveBtn}</div>`);
  } else if (t === "contact") {
    body = sec("Contact", `<div class="grid-2">
      <div class="field"><label>Email</label><input id="pe-email" type="email" value="${esc(e.email || "")}" /></div>
      <div class="field"><label>Desktop messaging</label><input id="pe-desk" value="${esc(e.desktopMessagingUsername || "")}" /></div>
      <div class="field"><label>Home phone</label><input id="pe-home-phone" value="${esc(e.homePhone || "")}" /></div>
      <div class="field"><label>Work phone</label><input id="pe-work-phone" value="${esc(e.workPhone || "")}" /></div>
      <div class="field"><label>Cell phone</label><input id="pe-cell-phone" value="${esc(e.cellPhone || "")}" /></div>
    </div>
    <div class="actions" style="margin-top:14px">${saveBtn}</div>`);
  } else if (t === "address") {
    const a = e.homeAddress || {};
    body = sec("Home address", `<div class="grid-2">
      <div class="field full"><label>Address line</label><input id="pe-addr-street" value="${esc(a.street1 || "")}" /></div>
      <div class="field"><label>City</label><input id="pe-addr-city" value="${esc(a.city || "")}" /></div>
      <div class="field"><label>State / province</label><input id="pe-addr-region" value="${esc(a.region || "")}" /></div>
      <div class="field"><label>Postal code</label><input id="pe-addr-postal" value="${esc(a.postalCode || "")}" /></div>
      <div class="field"><label>Country</label><input id="pe-addr-country" value="${esc(a.country || "")}" /></div>
    </div>
    <p class="hint">Stored as Employee.homeAddress JSONB.</p>
    <div class="actions" style="margin-top:14px">${saveBtn}</div>`);
  } else if (t === "admin") {
    body = sec("Administrative / employment", `<div class="grid-2">
      <div class="field"><label>Job title</label><input id="pe-title" value="${esc(e.jobTitle || "")}" /></div>
      <div class="field"><label>Employee type</label><select id="pe-type">${["FULL_TIME", "PART_TIME", "CONTRACTOR", "SEASONAL"].map((v) => `<option value="${v}" ${e.employmentType === v ? "selected" : ""}>${typeLabel(v)}</option>`).join("")}</select></div>
      <div class="field"><label>Contract hours / week</label><input id="pe-hours" type="number" value="${e.contractHoursPerWeek}" /></div>
      <div class="field"><label>Cost center</label><input id="pe-cc" value="${esc(e.costCenter || "")}" /></div>
      <div class="field"><label>Wage amount</label><input id="pe-wage" type="number" step="0.01" value="${e.wageAmount == null ? "" : e.wageAmount}" /></div>
      <div class="field"><label>Rank</label><input id="pe-rank" type="number" value="${e.rank == null ? "" : e.rank}" /></div>
    </div>
    <div style="display:flex;gap:16px;margin-top:10px">
      <label class="toggle"><input type="checkbox" id="pe-sup" ${e.isSupervisor ? "checked" : ""} /> Is Supervisor</label>
      <label class="toggle"><input type="checkbox" id="pe-tl" ${e.isTeamLead ? "checked" : ""} /> Is Team Lead</label>
    </div>
    <dl class="kv" style="margin-top:14px">
      <dt>Start date</dt><dd class="mono">${esc(e.hireDate)}</dd>
      <dt>End date</dt><dd class="mono">${esc(e.terminationDate || "—")}</dd>
      <dt>Employee number</dt><dd class="mono">${esc(e.employeeNumber)}</dd>
      <dt>Tax ID / SSN</dt><dd>${esc(e.taxIdLastFour ? "••" + e.taxIdLastFour : "—")} <span class="muted">Only the last four digits are shown here; view the full value separately.</span></dd>
      <dt>Status</dt><dd>${stBadge(e.status)}</dd>
    </dl>
    <div class="actions" style="margin-top:14px">${saveBtn}</div>`);
  } else if (t === "org") {
    body = sec("Organization", `<dl class="kv">
      <dt>Organization unit</dt><dd>${esc(realOrgName(state, e.orgUnitId))}</dd>
      <dt>Supervisor</dt><dd>${e.manager ? `${esc(empLabel(state, empById(state, e.manager.id) || e.manager))}` : "—"} <span class="muted">managerEmployeeId</span></dd>
      <dt>Groups</dt><dd>${(e.groups || []).map((g) => esc(g.name)).join(", ") || "—"} <span class="muted">via employee_group_members, not a column on Employee</span></dd>
    </dl>
    <div class="field" style="margin-top:10px"><label>Team Lead</label><select id="pe-lead"><option value="">—</option>${(state.wf.employees || []).filter((x) => x.id !== e.id).map((x) => `<option value="${x.id}" ${e.teamLead && e.teamLead.id === x.id ? "selected" : ""}>${esc(empLabel(state, x))}</option>`).join("")}</select></div>
    <div class="callout" style="margin-top:10px">Supervisor and Team Lead are separate relationships — a person can be both, or neither. Organization unit and Supervisor change via Transfer (writes history); Team Lead saves directly here.</div>
    <div class="actions" style="margin-top:10px">${saveBtn}<button class="btn" data-wf="open-xfer">Transfer</button></div>`);
  } else {
    if (!state.wf.acdConnectors) loadAcdConnectors(state);
    const connectors = state.wf.acdConnectors || [];
    const dsList = `<datalist id="pe-ds-list">${connectors.map((c) => `<option value="${esc(c.provider)}">${esc(c.provider)} · ${c.status}</option>`).join("")}</datalist>`;
    const rows = e.dataSources || [];
    const editingRowId = state.dsEditTarget;
    body = sec("Workforce / External Identity", `<p class="hint" style="margin-top:0">One row per ACD system this employee is provisioned on (Avaya AACC, Communication Manager, a speech-recognition data source, this WFM system's own data source, ...) — an employee can hold more than one.</p>
      <table class="data"><thead><tr><th>Data source</th><th>Agent ID</th><th>Extension</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((d) => editingRowId === d.id
        ? `<tr>
            <td>${esc(d.dataSource)}</td>
            <td><input id="ds-edit-agent-${d.id}" value="${esc(d.agentId || "")}" style="width:100%" /></td>
            <td><input id="ds-edit-ext-${d.id}" value="${esc(d.extension || "")}" style="width:100%" /></td>
            <td><button class="btn btn-sm" data-wf="save-ds-edit" data-id="${d.id}" ${state.wf.saving.dsEdit ? "disabled" : ""}>${state.wf.saving.dsEdit ? "Saving…" : "Save"}</button> <button class="btn btn-sm" data-wf="cancel-ds-edit">Cancel</button></td>
          </tr>`
        : `<tr>
            <td>${esc(d.dataSource)}</td>
            <td class="mono">${esc(d.agentId || "—")}</td>
            <td class="mono">${esc(d.extension || "—")}</td>
            <td><button class="btn btn-sm" data-wf="edit-ds" data-id="${d.id}">Edit</button> <button class="btn btn-sm" data-wf="remove-ds" data-id="${d.id}">Remove</button></td>
          </tr>`
      ).join("") : `<tr><td colspan="4" class="muted">No data sources yet.</td></tr>`}</tbody></table>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Data source</label><input id="ds-new-source" list="pe-ds-list" placeholder="${connectors.length ? "Pick or type a data source" : "No ACD connectors configured for this tenant yet — type manually"}" />${dsList}</div>
        <div class="field"><label>Agent ID</label><input id="ds-new-agent" /></div>
        <div class="field"><label>Extension</label><input id="ds-new-ext" /></div>
      </div>
      <button class="btn" style="margin-top:8px" data-wf="add-ds" data-id="${e.id}" ${state.wf.saving.dsAdd ? "disabled" : ""}>${state.wf.saving.dsAdd ? "Adding…" : "+ Add data source"}</button>
      <dl class="kv" style="margin-top:14px">
        <dt>Linked user</dt><dd>${e.userId ? "See Personal tab" : "Headcount only — userId nullable"}</dd>
        <dt>Desktop messaging</dt><dd>${esc(e.desktopMessagingUsername || "—")} <span class="muted">See Contact tab</span></dd>
      </dl>`);
  }
  return `
    ${pageHead(`${e.employeeNumber}${empName(state, e) ? " · " + empName(state, e) : ""}`, "Same employee record used in Groups, Preferences, Time Off, Skills, Work Rules, Interactions, Staffing.", `
      ${stBadge(e.status)}
      <button class="btn" data-wf="tab" data-id="profiles">Back</button>
      ${e.status !== "TERMINATED" ? `<button class="btn" data-wf="terminate-emp" data-id="${e.id}">Terminate</button>` : ""}
    `)}
    <div class="tabs">${tabs.map(([id2, l]) => `<button class="tab ${t === id2 ? "on" : ""}" data-wf="emp-tab" data-id="${id2}">${l}</button>`).join("")}</div>
    ${body}`;
}

export function renderDrawer(state) {
  const d = state.drawer;
  if (d === "add-emp") {
    const orgOptions = state.data.orgUnits || [];
    const emps = state.wf.employees || [];
    const linkedIds = new Set(emps.map((e) => e.userId).filter(Boolean));
    const linkableUsers = (state.wf.users || []).filter((u) => !linkedIds.has(u.id));
    const mode = state.ceUserMode || "existing";
    if (!state.wf.acdConnectors) loadAcdConnectors(state);
    const connectors = state.wf.acdConnectors || [];
    return drawerShell("Create employee", "createEmployee · employeeNumber, orgUnitId, employmentType, contractHoursPerWeek, hireDate required.",
      `<div class="callout" style="margin-bottom:12px">Employee has no name column of its own — a display name only appears once this employee is linked to a User account.</div>
      <div class="seg" role="tablist" aria-label="Name source">
        <button type="button" class="${mode === "existing" ? "on" : ""}" data-wf="ce-user-mode" data-id="existing">Link existing user</button>
        <button type="button" class="${mode === "new" ? "on" : ""}" data-wf="ce-user-mode" data-id="new">Create new user</button>
        <button type="button" class="${mode === "none" ? "on" : ""}" data-wf="ce-user-mode" data-id="none">Headcount only</button>
      </div>
      ${mode === "existing" ? `<div class="field" style="margin-top:10px"><label>Linked user</label><select id="ce-user"><option value="">— Select a user —</option>${linkableUsers.map((u) => `<option value="${u.id}">${esc(`${u.givenName || ""} ${u.familyName || ""}`.trim() || u.email)} · ${esc(u.email)}</option>`).join("")}</select></div>` : ""}
      ${mode === "new" ? `<div class="grid-2" style="margin-top:10px">
        <div class="field"><label>First name <span class="req">*</span></label><input id="ce-new-given" /></div>
        <div class="field"><label>Last name <span class="req">*</span></label><input id="ce-new-family" /></div>
        <div class="field full"><label>Email <span class="req">*</span></label><input id="ce-new-email" type="email" placeholder="Used for account invite" /></div>
      </div>
      <p class="hint">Sends the same invite email as the Usernames screen, then links the new account to this employee — no separate trip needed.</p>` : ""}
      ${mode === "none" ? `<p class="hint" style="margin-top:10px">Headcount-only record — no login access, no display name until linked later.</p>` : ""}
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Employee number <span class="req">*</span></label><input id="ce-number" /></div>
        <div class="field"><label>Org unit <span class="req">*</span></label><select id="ce-org">${orgOptions.map((o) => `<option value="${o.id}">${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Employment type <span class="req">*</span></label><select id="ce-type"><option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACTOR">Contractor</option><option value="SEASONAL">Seasonal</option></select></div>
        <div class="field"><label>Contract hours / week <span class="req">*</span></label><input id="ce-hours" type="number" value="40" /></div>
        <div class="field"><label>Start date <span class="req">*</span></label><input id="ce-hire" type="date" /></div>
        <div class="field"><label>Job title</label><input id="ce-title" /></div>
        <div class="field"><label>Supervisor</label><select id="ce-mgr"><option value="">—</option>${emps.map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("")}</select></div>
        <div class="field"><label>Team Lead</label><select id="ce-lead"><option value="">—</option>${emps.map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("")}</select></div>
      </div>
      ${sec("Personal", `<div class="grid-2">
        <div class="field"><label>Middle initial</label><input id="ce-mi" maxlength="10" /></div>
        <div class="field"><label>Suffix</label><input id="ce-suffix" maxlength="20" /></div>
        <div class="field"><label>Birth date</label><input id="ce-birth" type="date" /></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Photo</label>
        ${state.ceAvatarPreview ? `<img src="${state.ceAvatarPreview}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px" />` : ""}
        <input type="file" id="ce-avatar-input" data-wf="ce-avatar-input" accept="image/png,image/jpeg,image/webp" style="display:inline-block" />
        <p class="hint">Uploaded right after the employee record is created — the upload endpoint needs a real employee id first.</p>
      </div>`)}
      ${sec("Contact", `<div class="grid-2">
        <div class="field"><label>Email</label><input id="ce-email" type="email" /></div>
        <div class="field"><label>Desktop messaging</label><input id="ce-desk" /></div>
        <div class="field"><label>Home phone</label><input id="ce-home-phone" /></div>
        <div class="field"><label>Work phone</label><input id="ce-work-phone" /></div>
        <div class="field"><label>Cell phone</label><input id="ce-cell-phone" /></div>
      </div>`)}
      ${sec("Home address", `<div class="grid-2">
        <div class="field full"><label>Address line</label><input id="ce-addr-street" /></div>
        <div class="field"><label>City</label><input id="ce-addr-city" /></div>
        <div class="field"><label>State / province</label><input id="ce-addr-region" /></div>
        <div class="field"><label>Postal code</label><input id="ce-addr-postal" /></div>
        <div class="field"><label>Country</label><input id="ce-addr-country" /></div>
      </div>`)}
      ${sec("Workforce / External Identity", `<p class="hint" style="margin-top:0">One row per ACD system (Avaya AACC, Communication Manager, ...) — added right after the employee record is created, same reason the photo waits: the add-data-source mutation needs a real employee id first.</p>
        <table class="data"><thead><tr><th>Data source</th><th>Agent ID</th><th>Extension</th><th></th></tr></thead>
        <tbody id="ce-ds-rows"></tbody></table>
        <datalist id="ce-ds-list">${connectors.map((c) => `<option value="${esc(c.provider)}">${esc(c.provider)} · ${c.status}</option>`).join("")}</datalist>
        <button type="button" class="btn btn-sm" style="margin-top:8px" data-wf="ce-ds-add-row">+ Add data source</button>`)}`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="add-emp-go" ${state.wf.saving.emp ? "disabled" : ""}>${state.wf.saving.emp ? "Creating…" : "Create"}</button>`);
  }
  if (d === "xfer") {
    const orgOptions = state.data.orgUnits || [];
    const emps = state.wf.employees || [];
    return drawerShell("Transfer employee", "transferEmployee — writes history. Supervisor and Team Lead stay distinct.",
      `<div class="field"><label>New org unit</label><select id="xf-org">${orgOptions.map((o) => `<option value="${o.id}">${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
       <div class="field" style="margin-top:10px"><label>New supervisor</label><select id="xf-mgr"><option value="">—</option>${emps.map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("")}</select></div>
       <div class="field" style="margin-top:10px"><label>Effective date</label><input id="xf-date" type="date" /></div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="xfer-go" ${state.wf.saving.xfer ? "disabled" : ""}>${state.wf.saving.xfer ? "Transferring…" : "Transfer"}</button>`);
  }
  return "";
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "export-employees") {
    Api.downloadCsv(
      "employees.csv",
      state.wf.employees || [],
      [
        { label: "Employee Number", value: "employeeNumber" },
        { label: "Name", value: (e) => empName(state, e) || "" },
        { label: "Job Title", value: "jobTitle" },
        { label: "Organization", value: (e) => realOrgName(state, e.orgUnitId) },
        { label: "Type", value: "employmentType" },
        { label: "Status", value: "status" },
        { label: "Start", value: "hireDate" },
        { label: "Data Sources", value: (e) => (e.dataSources || []).map((d) => `${d.dataSource}:${d.agentId || "—"}/${d.extension || "—"}`).join("; ") },
      ]
    );
    toast("Exported employees.csv (client-side — no export API).");
    return true;
  }
  if (act === "open-add-emp") {
    state.ceUserMode = "existing";
    state.ceAvatarPreview = null;
    state.ceAvatarFile = null;
    state.ceDsRowSeq = 0;
    return set("drawer", "add-emp");
  }
  if (act === "ce-ds-add-row") {
    // Direct DOM insertion, deliberately not doRerender() — same reason as
    // the avatar preview: this drawer has ~20 other plain uncontrolled
    // fields a full re-render would wipe.
    const tbody = document.getElementById("ce-ds-rows");
    if (!tbody) return false;
    const rowId = (state.ceDsRowSeq = (state.ceDsRowSeq || 0) + 1);
    const tr = document.createElement("tr");
    tr.dataset.dsRow = String(rowId);
    tr.innerHTML = `
      <td><input list="ce-ds-list" style="width:100%" /></td>
      <td><input style="width:100%" /></td>
      <td><input style="width:100%" /></td>
      <td><button type="button" class="btn btn-sm" data-wf="ce-ds-remove-row" data-id="${rowId}">Remove</button></td>
    `;
    tbody.appendChild(tr);
    return false;
  }
  if (act === "ce-ds-remove-row") {
    document.querySelector(`tr[data-ds-row="${id}"]`)?.remove();
    return false;
  }
  if (act === "ce-user-mode") return set("ceUserMode", id);
  if (act === "ce-avatar-input") {
    // Held directly on state, not re-read from the DOM at submit time: any
    // doRerender() while this drawer is open (e.g. a background roster
    // refetch completing) replaces #ce-avatar-input with a fresh element —
    // a file <input>'s selection can never be restored via JS/state once
    // that happens, so the underlying File object itself is what has to
    // survive the rerender, same lesson as every other uncontrolled-input
    // fix this session, just with no DOM-side workaround available here.
    const input = document.getElementById("ce-avatar-input");
    const file = input?.files && input.files[0];
    state.ceAvatarFile = file || null;
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        // Direct DOM update, deliberately not doRerender(): this drawer has
        // ~20 other plain uncontrolled fields (employee number, org unit,
        // hire date, ...) that aren't bound to draft state — a full
        // re-render here would wipe out whatever the user has already
        // typed elsewhere in the form, exactly the bug this session kept
        // finding and fixing, just newly introduced by this preview itself
        // if it went through doRerender().
        state.ceAvatarPreview = reader.result;
        const field = input.closest(".field");
        if (field) {
          let img = field.querySelector("img");
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.style.cssText = "width:48px;height:48px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px";
            field.insertBefore(img, input);
          }
          img.src = state.ceAvatarPreview;
        }
      };
      reader.readAsDataURL(file);
    } else {
      state.ceAvatarPreview = null;
    }
    return false;
  }
  if (act === "add-emp-go") {
    const orgUnitId = $("#ce-org")?.value;
    const employeeNumber = $("#ce-number")?.value.trim();
    const employmentType = $("#ce-type")?.value;
    const contractHoursPerWeek = Number($("#ce-hours")?.value);
    const hireDate = $("#ce-hire")?.value;
    const jobTitle = $("#ce-title")?.value.trim();
    const managerEmployeeId = $("#ce-mgr")?.value || undefined;
    const teamLeadEmployeeId = $("#ce-lead")?.value || undefined;
    const middleInitial = $("#ce-mi")?.value.trim() || undefined;
    const suffix = $("#ce-suffix")?.value.trim() || undefined;
    const birthDate = $("#ce-birth")?.value || undefined;
    const email = $("#ce-email")?.value.trim() || undefined;
    const desktopMessagingUsername = $("#ce-desk")?.value.trim() || undefined;
    const homePhone = $("#ce-home-phone")?.value.trim() || undefined;
    const workPhone = $("#ce-work-phone")?.value.trim() || undefined;
    const cellPhone = $("#ce-cell-phone")?.value.trim() || undefined;
    const street1 = $("#ce-addr-street")?.value.trim();
    const city = $("#ce-addr-city")?.value.trim();
    const region = $("#ce-addr-region")?.value.trim();
    const postalCode = $("#ce-addr-postal")?.value.trim();
    const country = $("#ce-addr-country")?.value.trim();
    const homeAddress = street1 || city || region || postalCode || country
      ? { street1: street1 || undefined, city: city || undefined, region: region || undefined, postalCode: postalCode || undefined, country: country || undefined }
      : undefined;
    // Collected now, before any async work — addEmployeeDataSource needs a
    // real employeeId, so these are staged in plain DOM rows (see
    // "ce-ds-add-row") and only sent once creation succeeds below. Reading
    // them synchronously here, not inside the .then(), because the success
    // handler's own doRerender() (closing the drawer) destroys these rows.
    const stagedDataSources = Array.from(document.querySelectorAll("#ce-ds-rows tr[data-ds-row]"))
      .map((tr) => {
        const inputs = tr.querySelectorAll("input");
        return { dataSource: inputs[0]?.value.trim(), agentId: inputs[1]?.value.trim() || undefined, extension: inputs[2]?.value.trim() || undefined };
      })
      .filter((row) => row.dataSource);
    if (!employeeNumber || !orgUnitId || !hireDate) {
      toast("Employee number, org unit, and start date are required.");
      return true;
    }
    const mode = state.ceUserMode || "existing";
    let newUserFields = null;
    if (mode === "new") {
      const givenName = $("#ce-new-given")?.value.trim();
      const familyName = $("#ce-new-family")?.value.trim();
      const newUserEmail = $("#ce-new-email")?.value.trim();
      if (!givenName || !familyName || !newUserEmail) {
        toast("First name, last name, and email are required to create a new user.");
        return true;
      }
      newUserFields = { givenName, familyName, email: newUserEmail };
    }
    const userId = mode === "existing" ? ($("#ce-user")?.value || undefined) : undefined;

    const createEmployeeWith = (linkedUserId) => {
      state.wf.saving.emp = true;
      doRerender();
      Api.gqlFetch(
        `mutation Create($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`,
        {
          input: {
            orgUnitId, employeeNumber, employmentType, contractHoursPerWeek, hireDate,
            jobTitle: jobTitle || undefined, managerEmployeeId, teamLeadEmployeeId, userId: linkedUserId,
            middleInitial, suffix, birthDate, email, desktopMessagingUsername, homePhone, workPhone, cellPhone, homeAddress,
          },
        }
      )
        .then((res) => {
          state.wf.saving.emp = false;
          state.wf.employees = null;
          state.wf.employeesPageKey = null;
          state.wf.users = null;
          state.drawer = null;
          toast("Employee created.");
          const newId = res.createEmployee.id;
          const avatarFile = state.ceAvatarFile;
          state.ceAvatarFile = null;
          state.ceAvatarPreview = null;
          if (avatarFile) {
            const form = new FormData();
            form.append("file", avatarFile);
            Api.rootApi(`/v1/employees/${newId}/avatar`, { method: "POST", body: form })
              .catch((err) => toast("Employee created, but the photo upload failed: " + errMsg(err)));
          }
          if (stagedDataSources.length) {
            Promise.allSettled(
              stagedDataSources.map((row) =>
                Api.gqlFetch(
                  `mutation($input: CreateEmployeeDataSourceInput!) { addEmployeeDataSource(input: $input) { id } }`,
                  { input: { employeeId: newId, ...row } }
                )
              )
            ).then((results) => {
              const failed = results.filter((r) => r.status === "rejected");
              if (failed.length) toast(`Employee created, but ${failed.length} of ${stagedDataSources.length} data source(s) failed to save.`);
            });
          }
          loadEmployees(state);
        })
        .catch((err) => {
          state.wf.saving.emp = false;
          toast(errMsg(err));
          doRerender();
        });
    };

    if (mode === "new") {
      state.wf.saving.emp = true;
      doRerender();
      Api.rootApi("/v1/users/invite", { method: "POST", body: newUserFields })
        .then((res) => createEmployeeWith(res.user.id))
        .catch((err) => {
          state.wf.saving.emp = false;
          toast(errMsg(err));
          doRerender();
        });
      return true;
    }
    createEmployeeWith(userId);
    return true;
  }
  if (act === "open-xfer") return set("drawer", "xfer");
  if (act === "xfer-go") {
    const newOrgUnitId = $("#xf-org")?.value;
    const newManagerEmployeeId = $("#xf-mgr")?.value || undefined;
    const effectiveDate = $("#xf-date")?.value || undefined;
    state.wf.saving.xfer = true;
    Api.gqlFetch(
      `mutation Xfer($employeeId: ID!, $newOrgUnitId: ID!, $newManagerEmployeeId: ID, $effectiveDate: String) { transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId, newManagerEmployeeId: $newManagerEmployeeId, effectiveDate: $effectiveDate) { id } }`,
      { employeeId: state.empId, newOrgUnitId, newManagerEmployeeId, effectiveDate }
    )
      .then(() => {
        state.wf.saving.xfer = false;
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        delete state.wf.employeeDetail[state.empId];
        state.drawer = null;
        toast("Employee transferred.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.xfer = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "terminate-emp") {
    Api.gqlFetch(
      `mutation Term($id: ID!) { updateEmployee(id: $id, input: { status: TERMINATED }) { id } }`,
      { id }
    )
      .then(() => {
        delete state.wf.employeeDetail[id];
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        toast("Employee terminated.");
        loadEmployeeDetail(state, id);
        loadEmployees(state);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "upload-avatar") {
    const input = document.getElementById(`avatar-input-${id}`);
    const file = input?.files && input.files[0];
    if (!file) {
      toast("Choose a file first.");
      return true;
    }
    const form = new FormData();
    form.append("file", file);
    Api.rootApi(`/v1/employees/${id}/avatar`, { method: "POST", body: form })
      .then(() => {
        delete state.wf.employeeDetail[id];
        toast("Avatar uploaded.");
        loadEmployeeDetail(state, id);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "add-ds") {
    const dataSource = $("#ds-new-source")?.value.trim();
    const agentId = $("#ds-new-agent")?.value.trim() || undefined;
    const extension = $("#ds-new-ext")?.value.trim() || undefined;
    if (!dataSource) {
      toast("Data source is required.");
      return true;
    }
    state.wf.saving.dsAdd = true;
    doRerender();
    Api.gqlFetch(
      `mutation($input: CreateEmployeeDataSourceInput!) { addEmployeeDataSource(input: $input) { id } }`,
      { input: { employeeId: id, dataSource, agentId, extension } }
    )
      .then(() => {
        state.wf.saving.dsAdd = false;
        delete state.wf.employeeDetail[id];
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        toast("Data source added.");
        loadEmployeeDetail(state, id);
      })
      .catch((err) => {
        state.wf.saving.dsAdd = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "edit-ds") return set("dsEditTarget", id);
  if (act === "cancel-ds-edit") return set("dsEditTarget", null);
  if (act === "save-ds-edit") {
    const agentId = $(`#ds-edit-agent-${id}`)?.value.trim() || null;
    const extension = $(`#ds-edit-ext-${id}`)?.value.trim() || null;
    state.wf.saving.dsEdit = true;
    doRerender();
    Api.gqlFetch(
      `mutation($input: UpdateEmployeeDataSourceInput!) { updateEmployeeDataSource(input: $input) { id } }`,
      { input: { id, agentId, extension } }
    )
      .then(() => {
        state.wf.saving.dsEdit = false;
        state.dsEditTarget = null;
        delete state.wf.employeeDetail[state.empId];
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        toast("Data source updated.");
        loadEmployeeDetail(state, state.empId);
      })
      .catch((err) => {
        state.wf.saving.dsEdit = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "remove-ds") {
    if (!confirm("Remove this data source from the employee?")) return true;
    Api.gqlFetch(`mutation($id: ID!) { removeEmployeeDataSource(id: $id) }`, { id })
      .then(() => {
        delete state.wf.employeeDetail[state.empId];
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        toast("Data source removed.");
        loadEmployeeDetail(state, state.empId);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "save-emp") {
    const tab = document.querySelector(`[data-wf="save-emp"][data-id="${id}"]`)?.dataset.tab;
    const input = {};
    if (tab === "personal") {
      input.userId = $("#pe-user")?.value || null;
      input.middleInitial = $("#pe-mi")?.value.trim() || null;
      input.suffix = $("#pe-suffix")?.value.trim() || null;
      input.birthDate = $("#pe-birth")?.value || null;
    } else if (tab === "contact") {
      input.email = $("#pe-email")?.value.trim() || null;
      input.desktopMessagingUsername = $("#pe-desk")?.value.trim() || null;
      input.homePhone = $("#pe-home-phone")?.value.trim() || null;
      input.workPhone = $("#pe-work-phone")?.value.trim() || null;
      input.cellPhone = $("#pe-cell-phone")?.value.trim() || null;
    } else if (tab === "address") {
      const street1 = $("#pe-addr-street")?.value.trim();
      const city = $("#pe-addr-city")?.value.trim();
      const region = $("#pe-addr-region")?.value.trim();
      const postalCode = $("#pe-addr-postal")?.value.trim();
      const country = $("#pe-addr-country")?.value.trim();
      input.homeAddress = street1 || city || region || postalCode || country
        ? { street1: street1 || undefined, city: city || undefined, region: region || undefined, postalCode: postalCode || undefined, country: country || undefined }
        : null;
    } else if (tab === "admin") {
      input.jobTitle = $("#pe-title")?.value.trim() || null;
      input.employmentType = $("#pe-type")?.value;
      input.contractHoursPerWeek = Number($("#pe-hours")?.value);
      input.costCenter = $("#pe-cc")?.value.trim() || null;
      const wage = $("#pe-wage")?.value;
      input.wageAmount = wage ? Number(wage) : null;
      const rank = $("#pe-rank")?.value;
      input.rank = rank ? Number(rank) : null;
      input.isSupervisor = !!$("#pe-sup")?.checked;
      input.isTeamLead = !!$("#pe-tl")?.checked;
    } else if (tab === "org") {
      input.teamLeadEmployeeId = $("#pe-lead")?.value || null;
    }
    state.wf.saving.emp = true;
    doRerender();
    Api.gqlFetch(
      `mutation Upd($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id } }`,
      { id, input }
    )
      .then(() => {
        state.wf.saving.emp = false;
        delete state.wf.employeeDetail[id];
        state.wf.employees = null;
        state.wf.employeesPageKey = null;
        toast("Saved.");
        loadEmployeeDetail(state, id);
        loadEmployees(state);
      })
      .catch((err) => {
        state.wf.saving.emp = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
