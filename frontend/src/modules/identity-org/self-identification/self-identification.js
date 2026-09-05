/* Self Identification — configures which employee properties are used for
   self-service identity matching. Wired to the real
   GET/PUT /v1/tenant-settings(/self-identification). */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../shared/ui.js';
import { loadSettings } from '../shared/loaders.js';

/* Real self-identification catalog (SelfIdentificationProperty enum, 11 values). */
const SID_CATALOG = [
  { id: "email", label: "Email", src: "User.email" },
  { id: "given_name", label: "First Name", src: "User.givenName" },
  { id: "family_name", label: "Last Name", src: "User.familyName" },
  { id: "employee_number", label: "Employee ID", src: "Employee.employeeNumber" },
  { id: "hire_date", label: "Start Date", src: "Employee.hireDate" },
  { id: "cost_center", label: "Cost Center", src: "Employee.costCenter" },
  { id: "middle_initial", label: "Middle Initial", src: "Employee.middleInitial" },
  { id: "birth_date", label: "Birth Date", src: "Employee.birthDate" },
  { id: "home_phone", label: "Home Phone", src: "Employee.homePhone" },
  { id: "work_phone", label: "Work Phone", src: "Employee.workPhone" },
  { id: "cell_phone", label: "Cell Phone", src: "Employee.cellPhone" },
];

export function render(state) {
  if (!state.wf.settings) {
    loadSettings(state);
    return pageHead("Self Identification", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  const selected = state.sidSelected || [];
  const q = (state.sidSearch || "").toLowerCase();
  const avail = SID_CATALOG.filter((p) => !selected.includes(p.id)).filter((p) => !q || p.label.toLowerCase().includes(q));
  const sel = selected.map((id) => SID_CATALOG.find((p) => p.id === id)).filter(Boolean);
  const dirty = JSON.stringify(selected) !== JSON.stringify(state.wf.settings.selfIdentificationProperties);
  return `
    ${pageHead("Self Identification", "Configure the employee information used to identify and match workforce records. Order is the ask order.", `
      <button class="btn" data-wf="sid-revert" ${dirty ? "" : "disabled"}>Revert</button>
      <button class="btn btn-primary" data-wf="sid-save" ${dirty && !state.sidSaving ? "" : "disabled"}>${state.sidSaving ? "Saving…" : "Save"}</button>`)}
    <div class="toolbar">
      <label class="search"><span>⌕</span><input data-wf="sid-search" value="${esc(state.sidSearch)}" placeholder="Search properties" /></label>
      <button class="btn btn-sm" data-wf="sid-clear">Clear search</button>
    </div>
    <div class="dual">
      <div class="dual-col">
        <h3>Available properties <span class="meta">${avail.length}</span></h3>
        <div class="dual-list">
          ${avail.map((p) => `<button class="${state.sidPickA === p.id ? "on" : ""}" data-wf="sid-pick-a" data-id="${p.id}"><b>${esc(p.label)}</b><div class="muted">${esc(p.src)}</div></button>`).join("") || `<div class="empty"><p>No unmatched live properties.</p></div>`}
        </div>
      </div>
      <div class="dual-mid">
        <button class="btn" data-wf="sid-add" ${state.sidPickA ? "" : "disabled"}>Add →</button>
        <button class="btn" data-wf="sid-rem" ${state.sidPickS ? "" : "disabled"}>← Remove</button>
        <button class="btn" data-wf="sid-add-all">Add all</button>
        <button class="btn" data-wf="sid-rem-all">Remove all</button>
        <button class="btn" data-wf="sid-up">Move up</button>
        <button class="btn" data-wf="sid-down">Move down</button>
      </div>
      <div class="dual-col">
        <h3>Selected properties <span class="meta">order matters</span></h3>
        <div class="dual-list">
          ${sel.map((p, i) => `<button class="${state.sidPickS === p.id ? "on" : ""}" data-wf="sid-pick-s" data-id="${p.id}"><b>${i + 1}. ${esc(p.label)}</b><div class="muted">${esc(p.src)}</div></button>`).join("") || empty("No properties selected.", "Self-service identity verification has nothing to ask for yet.")}
        </div>
      </div>
    </div>
    ${sec("Excluded from the catalog", `<div class="gap-row" style="padding:6px 0"><b>Tax ID / SSN</b> <span class="muted">Employee.taxId exists but is deliberately excluded — self-identification is a matching catalog, not a place to expose SSNs.</span></div>
      <div class="gap-row" style="padding:6px 0"><b>Data Source, Agent ID, Extension</b> <span class="muted">These identify an employee to an <i>external</i> system (Avaya, Genesys, ...) via EmployeeDataSource — a different concept from this <i>internal</i> WFM identity-matching catalog, so they're not selectable here even though they're real, queryable fields elsewhere (Profiles → Workforce / External Identity).</span></div>`, "")}
    <p class="hint">Live catalog is SelfIdentificationProperty (11 values). Duplicates cannot be added; the API rejects unknown ids.</p>`;
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "sid-search") return set("sidSearch", value);
  if (act === "sid-clear") return set("sidSearch", "");
  if (act === "sid-pick-a") return set("sidPickA", id);
  if (act === "sid-pick-s") return set("sidPickS", id);
  if (act === "sid-add" && state.sidPickA && !state.sidSelected.includes(state.sidPickA)) {
    state.sidSelected = [...state.sidSelected, state.sidPickA];
    state.sidPickA = null;
    return true;
  }
  if (act === "sid-rem" && state.sidPickS) {
    state.sidSelected = state.sidSelected.filter((x) => x !== state.sidPickS);
    state.sidPickS = null;
    return true;
  }
  if (act === "sid-add-all") {
    state.sidSelected = SID_CATALOG.map((p) => p.id);
    return true;
  }
  if (act === "sid-rem-all") { state.sidSelected = []; return true; }
  if (act === "sid-up" && state.sidPickS) {
    const i = state.sidSelected.indexOf(state.sidPickS);
    if (i > 0) {
      const a = state.sidSelected.slice();
      [a[i - 1], a[i]] = [a[i], a[i - 1]];
      state.sidSelected = a;
    }
    return true;
  }
  if (act === "sid-down" && state.sidPickS) {
    const i = state.sidSelected.indexOf(state.sidPickS);
    if (i >= 0 && i < state.sidSelected.length - 1) {
      const a = state.sidSelected.slice();
      [a[i + 1], a[i]] = [a[i], a[i + 1]];
      state.sidSelected = a;
    }
    return true;
  }
  if (act === "sid-revert") {
    state.sidSelected = state.wf.settings ? [...state.wf.settings.selfIdentificationProperties] : [];
    return true;
  }
  if (act === "sid-save") {
    state.sidSaving = true;
    Api.rootApi("/v1/tenant-settings/self-identification", { method: "PUT", body: { properties: state.sidSelected } })
      .then((updated) => {
        state.wf.settings = updated;
        state.sidSaving = false;
        toast("Self identification settings saved.");
        doRerender();
      })
      .catch((err) => {
        state.sidSaving = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
