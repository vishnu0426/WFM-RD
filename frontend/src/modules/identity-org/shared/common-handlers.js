/* Trivial per-feature selection/filter setters that were originally at the
   top of workforce.js's single handle() dispatcher, shared across several
   screens (e.g. "pick-user" is used by both Usernames and User Access
   Rights). Tried by the module's index.js dispatcher before delegating to
   the active tab's own handle(). */
export function handleCommon(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "emp-search") return set("empSearch", value);
  if (act === "emp-st") { state.empFilter.status = value; state.empPage = 0; return true; }
  if (act === "emp-ty") { state.empFilter.type = value; state.empPage = 0; return true; }
  if (act === "emp-ou") { state.empFilter.ou = value; state.empPage = 0; return true; }
  if (act === "emp-page-prev") { state.empPage = Math.max(0, (state.empPage || 0) - 1); return true; }
  if (act === "emp-page-next") { state.empPage = (state.empPage || 0) + 1; return true; }
  /* No state.tab reassignment here: only ever dispatched from within the
     Profiles screen itself (identity-org's or Forecasting & Scheduling's
     own Employees > Profiles), so state.tab is already the right one — and
     forcing it to identity-org's "profiles" id would break the F&S reuse
     (whose Profiles tab has a different id, fs-emp-profiles). */
  if (act === "open-emp") { state.empId = id; state.screen = "emp-detail"; state.empTab = "personal"; return true; }
  if (act === "emp-tab") return set("empTab", id);
  if (act === "pick-group") return set("groupId", id);
  if (act === "pref-emp") { state.prefDaysDraft = null; state.prefSlotsDraft = null; return set("prefEmp", id); }
  if (act === "leave-tab") return set("leaveTab", id);
  if (act === "pick-skill") return set("skillId", id);
  if (act === "pick-rule") return set("ruleId", id);
  if (act === "ix-emp") { state.ixSettingsDraft = null; return set("ixEmp", id); }
  if (act === "ix-type") return set("ixType", value);
  if (act === "pick-sp") return set("spId", id);
  if (act === "pick-user") return set("userId", id);
  if (act === "user-search") return set("userSearch", value);
  if (act === "user-st") { state.userFilter.status = value; return true; }
  if (act === "user-cred") { state.userFilter.cred = value; return true; }
  if (act === "open-sp") return set("drawer", "sp");
  if (act === "close-drawer") return set("drawer", null);
  return false;
}
