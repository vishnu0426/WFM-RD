/* Employee-domain lookups + query fragments shared across identity-org
   screens (Profiles, Groups, Schedule Preferences, Skills, Work Rules,
   Interactions). All take the shared app `state` as their first arg —
   same convention as the load* functions in loaders.js. */

export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const DAY_S = { sunday: "Sun", monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat" };
export const WEEKDAY_GQL = { sunday: "SUNDAY", monday: "MONDAY", tuesday: "TUESDAY", wednesday: "WEDNESDAY", thursday: "THURSDAY", friday: "FRIDAY", saturday: "SATURDAY" };
export const WEEKDAY_FROM_GQL = Object.fromEntries(Object.entries(WEEKDAY_GQL).map(([k, v]) => [v, k]));

export function realOrgName(state, id) {
    return (state.data.orgUnits || []).find((o) => o.id === id)?.name || (id ? "—" : "Entire organization");
  }

export function empById(state, id) {
    return (state.wf.employees || []).find((e) => e.id === id) || null;
  }
export function userFor(state, userId) {
    return (state.wf.users || []).find((u) => u.id === userId) || null;
  }
export function empName(state, e) {
    if (!e) return "—";
    const u = e.userId ? userFor(state, e.userId) : null;
    if (u) return `${u.givenName || ""} ${u.familyName || ""}`.trim() || u.email;
    return null;
  }
export function empLabel(state, e) {
    if (!e) return "—";
    const name = empName(state, e);
    return name ? `${name} · ${e.employeeNumber}` : e.employeeNumber;
  }

export const EMPLOYEE_DETAIL_QUERY = `
    query EmployeeDetail($id: ID!) {
      employee(id: $id) {
        id employeeNumber employmentType status contractHoursPerWeek hireDate terminationDate costCenter
        userId orgUnitId managerEmployeeId
        middleInitial suffix birthDate email desktopMessagingUsername homePhone workPhone cellPhone
        homeAddress { street1 city region postalCode country }
        isSupervisor isTeamLead teamLeadEmployeeId jobTitle wageAmount rank avatarUrl
        dataSources { id dataSource agentId extension updatedAt }
        taxIdLastFour
        manager { id employeeNumber }
        teamLead { id employeeNumber }
        groups { id name }
        skills { employeeId skillId proficiencyLevel certifiedDate expiryDate decayScore skill { name } }
        interactions { id interactionType body createdBy createdAt }
        schedulePreference { preferredShiftStart preferredShiftEnd preferredDaysOff maxWeeklyHours notes updatedAt preferenceSlots { rank startTime endTime earlyLate } }
        workRules { id name }
      }
    }
  `;
