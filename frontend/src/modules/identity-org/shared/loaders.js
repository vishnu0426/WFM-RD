/* Shared async data loaders for the identity-org module. Each takes the
   shared app `state` and mutates its `state.wf`/`state.data` caches,
   then calls doRerender() (see app/rerender.js) so the UI reflects the
   freshly loaded data — same fire-and-forget pattern the original
   monolithic workforce.js used, just relocated. */
import { Api } from '../../../core/api.js';
import { errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { EMPLOYEE_DETAIL_QUERY } from './employee-helpers.js';

export async function loadUsers(state) {
    if (state.wf.users) return state.wf.users;
    const data = await Api.gqlFetch(`query { users { id email givenName familyName username status employee { orgUnitId } } }`);
    state.wf.users = data.users;
    doRerender();
    return data.users;
  }

export async function loadSettings(state) {
    const s = await Api.rootApi("/v1/tenant-settings");
    state.wf.settings = s;
    if (state.sidSelected === null) state.sidSelected = [...s.selfIdentificationProperties];
    doRerender();
    return s;
  }

export async function loadRolesCatalog(state) {
    if (state.wf.roles) return state.wf.roles;
    const roles = await Api.rootApi("/v1/roles");
    state.wf.roles = roles;
    doRerender();
    return roles;
  }

export async function loadUserRoles(state, userId) {
    try {
      const rows = await Api.rootApi(`/v1/users/${userId}/roles`);
      state.wf.userRoles[userId] = rows;
    } catch (err) {
      state.wf.userRoles[userId] = { error: errMsg(err) };
    }
    doRerender();
  }

export async function loadCredStatus(state, userId) {
    try {
      const cs = await Api.rootApi(`/v1/users/${userId}/credential-status`);
      state.wf.credStatus[userId] = cs;
    } catch (err) {
      state.wf.credStatus[userId] = { error: errMsg(err) };
    }
    doRerender();
  }

export async function loadOrgUnits(state) {
    if (state.data.orgUnits) return state.data.orgUnits;
    const data = await Api.gqlFetch(`
      query { orgUnitRoots { id name type children { id name type children { id name type children { id name type } } } } }
    `);
    const flat = [];
    const walk = (nodes, depth) => {
      (nodes || []).forEach((n) => {
        flat.push({ id: n.id, name: n.name, type: n.type, depth });
        walk(n.children, depth + 1);
      });
    };
    walk(data.orgUnitRoots, 0);
    state.data.orgUnits = flat;
    doRerender();
    return flat;
  }

/**
 * The shared "roster" used by every picker/select across Groups, Schedule
 * Preferences, Skills, Work Rules, Interactions, and Staffing assignment —
 * these need the whole employee list to function as a picker, not a paged
 * view. `employees()` defaults its own `pagination.limit` to 50 server-side,
 * and the backend caps a single call's `limit` at 200
 * (`PaginationInput.limit`'s own `@Max(200)`) — fetching with no
 * `pagination` arg at all was silently truncating every one of those
 * pickers to the first 50 employees at any tenant past that size (GAP-06,
 * User Management audit). Pages through in real 200-row calls via
 * `employeesCount` rather than requesting one oversized limit the backend
 * would reject outright. The Profiles screen itself has its own real
 * server-driven pagination (`loadEmployeesPage` below), so this roster
 * fetch is only for populating pickers, not for a paged list view.
 */
const ROSTER_PAGE_SIZE = 200;
const ROSTER_MAX_PAGES = 25; // 5,000 employees — a sane corruption guard, not an expected tenant size

async function fetchAllEmployees() {
  const first = await Api.gqlFetch(
    `query($pagination: PaginationInput) { employees(pagination: $pagination) { id employeeNumber jobTitle orgUnitId managerEmployeeId teamLeadEmployeeId employmentType status hireDate userId isSupervisor isTeamLead dataSources { id dataSource agentId extension } } employeesCount }`,
    { pagination: { limit: ROSTER_PAGE_SIZE, offset: 0 } },
  );
  const all = [...first.employees];
  const total = first.employeesCount;
  for (let page = 1; all.length < total && page < ROSTER_MAX_PAGES; page += 1) {
    const next = await Api.gqlFetch(
      `query($pagination: PaginationInput) { employees(pagination: $pagination) { id employeeNumber jobTitle orgUnitId managerEmployeeId teamLeadEmployeeId employmentType status hireDate userId isSupervisor isTeamLead dataSources { id dataSource agentId extension } } }`,
      { pagination: { limit: ROSTER_PAGE_SIZE, offset: page * ROSTER_PAGE_SIZE } },
    );
    if (!next.employees.length) break;
    all.push(...next.employees);
  }
  return all;
}

export async function loadEmployees(state) {
    if (state.wf.employees) return state.wf.employees;
    // No try/catch, matching loadUsers' own existing convention right above
    // this function — every consumer across this module treats a truthy
    // state.wf.employees as "a real array," with no defensive .error check,
    // so swallowing a failure into an {error} shape here would be a new,
    // wider crash surface, not a safer one. A hard failure surfaces the
    // same way it always has: the screen stays on its loading skeleton.
    state.wf.employees = await fetchAllEmployees();
    doRerender();
    return state.wf.employees;
  }

/**
 * Profiles list's own paginated view (GAP-06 fix) — separate from the
 * roster above so pickers elsewhere are unaffected by which page Profiles
 * happens to be on. Status/type/org-unit filters are sent server-side;
 * free-text search stays client-side over the current page only (there is
 * no backend search endpoint over derived display name / Data Source), and
 * the Profiles screen discloses that in its own copy rather than pretending
 * search spans the whole tenant.
 */
export const EMPLOYEE_PAGE_SIZE = 25;

export async function loadEmployeesPage(state) {
    const f = state.empFilter || {};
    const page = state.empPage || 0;
    const filter = {};
    if (f.status) filter.status = f.status;
    if (f.type) filter.employmentType = f.type;
    if (f.ou) filter.orgUnitId = f.ou;
    const key = JSON.stringify({ filter, page });
    if (state.wf.employeesPageKey === key) return;
    state.wf.employeesPageKey = key;
    try {
      const data = await Api.gqlFetch(
        `query($filter: EmployeeFilterInput, $pagination: PaginationInput) {
          employees(filter: $filter, pagination: $pagination) { id employeeNumber jobTitle orgUnitId managerEmployeeId teamLeadEmployeeId employmentType status hireDate userId isSupervisor isTeamLead dataSources { id dataSource agentId extension } }
          employeesCount(filter: $filter)
        }`,
        { filter, pagination: { limit: EMPLOYEE_PAGE_SIZE, offset: page * EMPLOYEE_PAGE_SIZE } }
      );
      if (state.wf.employeesPageKey === key) {
        state.wf.employeesPage = data.employees;
        state.wf.employeesTotal = data.employeesCount;
      }
    } catch (err) {
      if (state.wf.employeesPageKey === key) {
        state.wf.employeesPage = { error: errMsg(err) };
        state.wf.employeesTotal = 0;
      }
    }
    doRerender();
  }

export async function loadEmployeeDetail(state, id) {
    try {
      const data = await Api.gqlFetch(EMPLOYEE_DETAIL_QUERY, { id });
      state.wf.employeeDetail[id] = data.employee;
    } catch (err) {
      state.wf.employeeDetail[id] = { error: errMsg(err) };
    }
    doRerender();
  }

export async function loadEmployeeGroups(state) {
    if (state.wf.employeeGroups) return state.wf.employeeGroups;
    const data = await Api.gqlFetch(`query { employeeGroups { id name description organizationId parentGroupId status } }`);
    state.wf.employeeGroups = data.employeeGroups;
    doRerender();
    return data.employeeGroups;
  }

export async function loadGroupDetail(state, id) {
    try {
      const data = await Api.gqlFetch(`query G($id: ID!) { employeeGroup(id: $id) { id name description organizationId parentGroupId status memberEmployeeIds } }`, { id });
      state.wf.groupDetail[id] = data.employeeGroup;
    } catch (err) {
      state.wf.groupDetail[id] = { error: errMsg(err) };
    }
    doRerender();
  }

export async function loadWorkRules(state) {
    if (state.wf.workRules) return state.wf.workRules;
    const data = await Api.gqlFetch(`
      query {
        workRules {
          id name description maxConsecutiveDays minRestHours maxWeeklyHours otEligible
          minPaidHours maxOtPerDay maxOtPerWeek maxVtoPerDay maxVtoPerWeek requiredPayPeriodHours effectiveFrom effectiveTo
          assignments { workRuleId assigneeType assigneeId assignedAt priority effectiveFrom effectiveTo }
        }
      }
    `);
    state.wf.workRules = data.workRules;
    doRerender();
    return data.workRules;
  }

export async function loadSkillsCatalog(state) {
    if (state.wf.skillsCatalog) return state.wf.skillsCatalog;
    const data = await Api.gqlFetch(`query { skills { id name category requiresCertification certificationValidityDays description status } }`);
    state.wf.skillsCatalog = data.skills;
    doRerender();
    return data.skills;
  }

export async function loadAllEmployeeSkills(state) {
    if (state.wf.employeeSkillsAll) return state.wf.employeeSkillsAll;
    const data = await Api.gqlFetch(`
      query { employees { id employeeNumber skills { employeeId skillId proficiencyLevel certifiedDate expiryDate decayScore } } }
    `);
    state.wf.employeeSkillsAll = data.employees;
    doRerender();
    return data.employees;
  }

