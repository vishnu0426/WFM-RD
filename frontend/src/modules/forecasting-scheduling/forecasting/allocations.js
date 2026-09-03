/* Forecasting > Allocations — headcount split across skills, per org unit.
   Wired to forecasting-service. Full-set replace only (PUT) — the
   sum-to-100% invariant only holds across the whole set, so there's no
   per-row save. Reuses identity-org's skills catalog — no second Skill
   model. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../../identity-org/shared/ui.js';
import { loadOrgUnits, loadSkillsCatalog } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);

async function loadAllocations(state, orgUnitId) {
  state.wf.allocations = state.wf.allocations || {};
  try {
    const resp = await ForecastingApi.getAllocations(orgUnitId);
    state.wf.allocations[orgUnitId] = resp.allocations;
  } catch (err) {
    state.wf.allocations[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.allocOu === undefined && orgUnits.length) state.allocOu = orgUnits[0].id;
  if (!state.wf.skillsCatalog) loadSkillsCatalog(state);
  const skills = isOk(state.wf.skillsCatalog) ? state.wf.skillsCatalog : [];
  const skillName = (id) => (skills.find((s) => s.id === id) || {}).name || id;

  if (!orgUnits.length) {
    return `${pageHead("Allocations", "Headcount split across skills, per org unit — wired to forecasting-service.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  state.wf.allocations = state.wf.allocations || {};
  const saved = state.wf.allocations[state.allocOu];
  if (saved === undefined) loadAllocations(state, state.allocOu);
  // Draft rows for the currently-selected org unit — reset whenever the
  // underlying saved set changes out from under it (org unit switch, reload).
  if (state.allocDraftFor !== state.allocOu && isOk(saved)) {
    state.allocDraft = saved.map((a) => ({ ...a }));
    state.allocDraftFor = state.allocOu;
  }
  const draft = state.allocDraftFor === state.allocOu ? (state.allocDraft || []) : null;
  const total = (draft || []).reduce((sum, a) => sum + (Number(a.allocationPercentage) || 0), 0);

  const body = !saved
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(saved) ? `<p class="muted">${esc(saved.error)}</p>`
    : `
      ${(draft || []).map((a, i) => `<div class="cov" style="margin-bottom:6px">
        <select data-alloc-skill="${i}">${skills.map((s) => `<option value="${s.id}" ${a.skillId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        <input type="number" min="0.01" max="100" step="0.1" data-alloc-pct="${i}" value="${a.allocationPercentage}" style="width:90px" />
        <button type="button" class="btn btn-sm" data-wf="alloc-remove" data-id="${i}">Remove</button>
      </div>`).join("") || `<p class="hint">No allocations yet — add one below.</p>`}
      <button type="button" class="btn btn-sm" data-wf="alloc-add" ${skills.length ? "" : "disabled"}>+ Add skill allocation</button>
      ${skills.length ? "" : `<p class="hint">No skills in the catalog yet — create one under Employees &gt; Skills first.</p>`}
      <p class="hint" style="margin-top:8px">Total: <b class="mono" style="color:${Math.abs(total - 100) < 0.01 ? "inherit" : "var(--danger,#c0392b)"}">${total.toFixed(1)}%</b> (must equal 100%)</p>
      <div class="actions" style="margin-top:10px"><button class="btn btn-primary" data-wf="alloc-save" ${state.wf.saving.alloc ? "disabled" : ""}>${state.wf.saving.alloc ? "Saving…" : "Save"}</button></div>`;

  return `
    ${pageHead("Allocations", "Headcount split across skills, per org unit — wired to forecasting-service.", "")}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Org unit</label>
      <select data-wf="alloc-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.allocOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
    </div>
    ${sec("Skill allocations", body)}`;
}

export function handle(state, act, id, value) {
  if (act === "alloc-ou") { state.allocOu = value; return true; }

  if (act === "alloc-add") {
    const skills = isOk(state.wf.skillsCatalog) ? state.wf.skillsCatalog : [];
    if (!skills.length) return true;
    state.allocDraft = state.allocDraft || [];
    state.allocDraft.push({ skillId: skills[0].id, allocationPercentage: 0 });
    return true;
  }
  if (act === "alloc-remove") {
    state.allocDraft.splice(Number(id), 1);
    return true;
  }

  if (act === "alloc-save") {
    const rows = (state.allocDraft || []).map((_, i) => ({
      skillId: document.querySelector(`[data-alloc-skill="${i}"]`)?.value,
      allocationPercentage: Number(document.querySelector(`[data-alloc-pct="${i}"]`)?.value || 0),
    }));
    if (!rows.length) { toast("Add at least one skill allocation."); return true; }
    const total = rows.reduce((s, a) => s + a.allocationPercentage, 0);
    if (Math.abs(total - 100) > 0.01) { toast(`Allocations must sum to 100% (currently ${total.toFixed(1)}%).`); return true; }
    const skillIds = rows.map((r) => r.skillId);
    if (new Set(skillIds).size !== skillIds.length) { toast("Each skill can only be allocated once."); return true; }
    state.wf.saving.alloc = true;
    doRerender();
    ForecastingApi.putAllocations(state.allocOu, rows)
      .then((resp) => {
        state.wf.saving.alloc = false;
        state.wf.allocations[state.allocOu] = resp.allocations;
        state.allocDraftFor = null;
        toast("Allocations saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.alloc = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
