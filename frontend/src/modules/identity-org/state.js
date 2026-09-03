/* Lazily initializes every identity-org-specific field on the shared app
   `state` object with a default, the first time it's touched — same
   idempotent pattern as before (safe to call on every render/handle).
   Called once at boot by app/state.js, and defensively at the top of
   every module's own render()/handle() dispatcher. */

export function initState(state) {
    state.tab = state.tab || "roles";
    state.empId = state.empId || null;
    state.empSearch = state.empSearch || "";
    state.empFilter = state.empFilter || { status: "", type: "", ou: "" };
    state.empTab = state.empTab || "personal";
    state.groupId = state.groupId || null;
    state.prefEmp = state.prefEmp || null;
    state.leaveTab = state.leaveTab || "queue";
    state.skillId = state.skillId || null;
    state.ruleId = state.ruleId || null;
    state.ixEmp = state.ixEmp || null;
    state.ixType = state.ixType || "";
    state.spId = state.spId || "sp-wd";
    state.drawer = state.drawer || null;
    state.sidSelected = state.sidSelected || null; // populated from real settings once loaded
    state.sidPickA = state.sidPickA || null;
    state.sidPickS = state.sidPickS || null;
    state.sidSearch = state.sidSearch || "";
    state.sidSaving = state.sidSaving || false;
    state.userId = state.userId ?? null;
    state.userSearch = state.userSearch || "";
    state.userFilter = state.userFilter || { status: "", cred: "" };
    state.userSel = state.userSel || new Set();
    state.scopeMode = state.scopeMode || "tenant";
    state.scopeOu = state.scopeOu || "";
    state.unsaved = state.unsaved || false;
    state.loading = state.loading || false;
    state.wf = state.wf || {
      users: null, settings: null, roles: null, userRoles: {}, credStatus: {}, saving: {},
      employees: null, employeeDetail: {}, employeeGroups: null, groupDetail: {},
      workRules: null, skillsCatalog: null, employeeSkillsAll: null,
      authPolicy: null, identityProviders: null, connectors: null, flagStatus: null, retentionPolicies: null,
      accessPolicy: null, systemLimitsPolicy: null, maintenancePolicy: null, notificationRules: null,
    };
    // --- System Configuration (real /v1/tenant-settings, /v1/policies,
    // /v1/identity-providers, integration-hub-service connectors,
    // adherence-compliance-service retention-policies — see system-config/*) ---
    state.scGeneralDraft = state.scGeneralDraft || null;
    state.scWfmDraft = state.scWfmDraft || null;
    state.scSecurityDraft = state.scSecurityDraft || null;
    state.scEmailDraft = state.scEmailDraft || null;
    state.scEmailTestResult = state.scEmailTestResult || null;
    state.scAuthPolicyDraft = state.scAuthPolicyDraft || null;
    state.scAccessDraft = state.scAccessDraft || null;
    state.scLimitsDraft = state.scLimitsDraft || null;
    state.scMaintenanceDraft = state.scMaintenanceDraft || null;
    state.scNotifEventType = state.scNotifEventType || 'skill_expiring';
    state.scWorkforceDraft = state.scWorkforceDraft || null;
    state.scIdpEditTarget = state.scIdpEditTarget || null;
    state.scIdpDraft = state.scIdpDraft || null;
    state.scIdpTestResult = state.scIdpTestResult || null;
    state.scConnectorDraft = state.scConnectorDraft || null;
    state.scFlagKey = state.scFlagKey || 'bulk_import_destructive';
    state.scRetentionEditTarget = state.scRetentionEditTarget || null;
    state.scRetentionDraft = state.scRetentionDraft || null;
  }
