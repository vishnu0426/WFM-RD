/* Skills — catalog + per-employee proficiency. Wired to GraphQL
   skills/createSkill/updateSkill/updateEmployeeSkills. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell } from '../shared/ui.js';
import { empLabel } from '../shared/employee-helpers.js';
import { loadSkillsCatalog, loadAllEmployeeSkills } from '../shared/loaders.js';

export function render(state) {
  if (!state.wf.skillsCatalog || !state.wf.employeeSkillsAll) {
    loadSkillsCatalog(state);
    loadAllEmployeeSkills(state);
    return pageHead("Skills", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.skillId === null && state.wf.skillsCatalog.length) state.skillId = state.wf.skillsCatalog[0].id;
  const s = state.wf.skillsCatalog.find((x) => x.id === state.skillId);
  const holders = [];
  (state.wf.employeeSkillsAll || []).forEach((e) => {
    (e.skills || []).filter((h) => h.skillId === state.skillId).forEach((h) => holders.push({ ...h, empNumber: e.employeeNumber }));
  });
  return `
    ${pageHead("Skills", "Catalog and employee proficiency. Levels are trainee / proficient / expert — not Beginner/Intermediate/Advanced.", `<button class="btn btn-primary" data-wf="open-skill">+ Create skill</button>`)}
    <div class="split">
      <div class="split-l">${state.wf.skillsCatalog.map((x) => `<button class="${x.id === state.skillId ? "on" : ""}" data-wf="pick-skill" data-id="${x.id}"><b>${esc(x.name)}</b><div class="muted">${esc(x.category)}${x.requiresCertification ? " · cert" : ""}</div></button>`).join("") || empty("No skills yet.")}</div>
      <div class="split-r">
        ${!s ? empty("Select a skill.") : `
        ${sec("Skill", `<dl class="kv">
          <dt>Name</dt><dd>${esc(s.name)}</dd>
          <dt>Category</dt><dd>${esc(s.category)}</dd>
          <dt>Description</dt><dd>${esc(s.description || "—")}</dd>
          <dt>Requires certification</dt><dd>${s.requiresCertification ? "Yes" : "No"}</dd>
          <dt>Validity days</dt><dd>${s.certificationValidityDays ?? "—"}</dd>
          <dt>Status</dt><dd>${stBadge(s.status)}</dd>
        </dl>
        <div class="actions" style="margin-top:8px"><button class="btn btn-sm" data-wf="edit-skill" data-id="${s.id}">Edit</button></div>`)}
        ${sec("Employee skills", `<table class="data"><thead><tr><th>Employee</th><th>Proficiency</th><th>Certified (effective)</th><th>Expiration</th><th>Decay</th></tr></thead>
          <tbody>${holders.map((h) => `<tr><td class="mono">${esc(h.empNumber)}</td><td>${h.proficiencyLevel}</td><td class="mono">${h.certifiedDate || "—"}</td><td class="mono">${h.expiryDate || "—"}</td><td class="mono">${h.decayScore}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No employees hold this skill.</td></tr>`}</tbody></table>
          <p class="hint">updateEmployeeSkills · expiry is trigger-computed; decay is computed by a nightly batch job (SkillDecayJobService), not the same trigger.</p>
          <div class="toolbar" style="margin-top:8px">
            <select id="skill-assign-emp">${(state.wf.employees || []).map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("")}</select>
            <select id="skill-assign-level"><option value="TRAINEE">Trainee</option><option value="PROFICIENT">Proficient</option><option value="EXPERT">Expert</option></select>
            <button class="btn" data-wf="assign-skill" data-id="${s.id}">Assign to employee</button>
          </div>`)}
        `}
      </div>
    </div>`;
}

export function renderDrawer(state) {
  if (state.drawer !== "skill") return "";
  const editing = state.editSkillTarget;
  return drawerShell(editing ? "Edit skill" : "Create skill", editing ? "updateSkill" : "createSkill",
    `<div class="field"><label>Name</label><input id="sk-name" value="${esc((editing && editing.name) || "")}" /></div>
     <div class="field" style="margin-top:10px"><label>Category</label><input id="sk-cat" value="${esc((editing && editing.category) || "")}" /></div>
     <div class="field" style="margin-top:10px"><label>Description</label><textarea id="sk-desc">${esc((editing && editing.description) || "")}</textarea></div>
     <label class="toggle" style="margin-top:10px"><input type="checkbox" id="sk-cert" ${editing && editing.requiresCertification ? "checked" : ""} /> Requires certification</label>
     <div class="field" style="margin-top:10px"><label>Certification validity (days)</label><input id="sk-days" type="number" value="${(editing && editing.certificationValidityDays) || ""}" /></div>
     ${editing ? `<div class="field" style="margin-top:10px"><label>Status</label><select id="sk-status"><option value="ACTIVE" ${editing.status === "ACTIVE" ? "selected" : ""}>Active</option><option value="DISABLED" ${editing.status === "DISABLED" ? "selected" : ""}>Disabled</option></select></div>` : ""}`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "skill-edit-go" : "skill-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.skill ? "disabled" : ""}>${state.wf.saving.skill ? "Saving…" : "Save"}</button>`);
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "open-skill") {
    state.editSkillTarget = null;
    return set("drawer", "skill");
  }
  if (act === "edit-skill") {
    state.editSkillTarget = (state.wf.skillsCatalog || []).find((s) => s.id === id);
    return set("drawer", "skill");
  }
  if (act === "skill-go" || act === "skill-edit-go") {
    const name = document.getElementById("sk-name")?.value.trim();
    const category = document.getElementById("sk-cat")?.value.trim();
    const description = document.getElementById("sk-desc")?.value.trim();
    const requiresCertification = !!document.getElementById("sk-cert")?.checked;
    const certificationValidityDays = document.getElementById("sk-days")?.value ? Number(document.getElementById("sk-days").value) : undefined;
    if (!name || !category) {
      toast("Name and category are required.");
      return true;
    }
    state.wf.saving.skill = true;
    const mutation = act === "skill-go"
      ? Api.gqlFetch(`mutation($input: CreateSkillInput!) { createSkill(input: $input) { id } }`, { input: { name, category, description: description || undefined, requiresCertification, certificationValidityDays } })
      : Api.gqlFetch(`mutation($input: UpdateSkillInput!) { updateSkill(input: $input) { id } }`, { input: { id, name, category, description: description || undefined, requiresCertification, certificationValidityDays, status: document.getElementById("sk-status")?.value } });
    mutation
      .then(() => {
        state.wf.saving.skill = false;
        state.wf.skillsCatalog = null;
        state.drawer = null;
        toast("Skill saved.");
        loadSkillsCatalog(state);
      })
      .catch((err) => {
        state.wf.saving.skill = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "assign-skill") {
    const employeeId = document.getElementById("skill-assign-emp")?.value;
    const proficiencyLevel = document.getElementById("skill-assign-level")?.value;
    if (!employeeId) return true;
    Api.gqlFetch(
      `mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { employeeId } }`,
      { input: { employeeId, skills: [{ skillId: id, proficiencyLevel }] } }
    )
      .then(() => {
        state.wf.employeeSkillsAll = null;
        toast("Skill assigned.");
        loadAllEmployeeSkills(state);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
