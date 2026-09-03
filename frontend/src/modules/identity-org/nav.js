/* Navigation registry + permission-catalog display metadata for the
   identity-org module (root service, Modules 01+02). */

export const NAV = {
    Security: [
      { id: "roles", label: "Roles Setup", live: true },
      { id: "selfid", label: "Self Identification", live: true },
      { id: "usernames", label: "Usernames", live: true },
      { id: "uar", label: "User Access Rights", live: true },
    ],
    Employees: [
      { id: "profiles", label: "Profiles", live: true },
      { id: "groups", label: "Groups", live: true },
      { id: "prefs", label: "Schedule Preferences", live: true },
      { id: "timeoff", label: "Time Off", live: true },
      { id: "skills", label: "Skills", live: true },
      { id: "rules", label: "Work Rules", live: true },
      { id: "interactions", label: "Interactions", live: true },
    ],
    "Staffing Profile": [{ id: "staffing", label: "Staffing Profile", live: true }],
    "System Configuration": [
      { id: "sc-general", label: "General", live: true },
      { id: "sc-wfm", label: "WFM Defaults", live: true },
      { id: "sc-security", label: "Security", live: true },
      { id: "sc-email", label: "Email", live: true },
      { id: "sc-sso", label: "Authentication", live: true },
      { id: "sc-features", label: "Feature Configuration", live: true },
      { id: "sc-notifications", label: "Notifications", live: true },
      { id: "sc-retention", label: "Retention", live: true },
      { id: "sc-advanced", label: "Advanced", live: true },
    ],
  };
export const FIRST = {
    Security: "roles",
    Employees: "profiles",
    "Staffing Profile": "staffing",
    "System Configuration": "sc-general",
  };
export const GROUP_OF = {};
Object.entries(NAV).forEach(([g, tabs]) => tabs.forEach((t) => (GROUP_OF[t.id] = g)));
export const LEAF_SCREEN = {
    roles: "list", selfid: "selfid", usernames: "usernames", uar: "uar",
    profiles: "profiles", groups: "groups", prefs: "prefs", timeoff: "timeoff",
    skills: "skills", rules: "rules", interactions: "interactions", staffing: "staffing",
    "sc-general": "sc-general", "sc-wfm": "sc-wfm", "sc-security": "sc-security",
    "sc-email": "sc-email", "sc-sso": "sc-sso",
    "sc-features": "sc-features", "sc-notifications": "sc-notifications",
    "sc-retention": "sc-retention", "sc-advanced": "sc-advanced",
  };


export const RESOURCE_META = {
    role: { label: "Roles Setup", group: "Security", module: "Authorization" },
    user: { label: "Usernames & Accounts", group: "Security", module: "Authorization" },
    audit: { label: "Role activity (contextual)", group: "Security", module: "Authorization" },
    tenant: { label: "Tenant", group: "Security", module: "Administration" },
    tenant_settings: { label: "Tenant settings / Self Identification", group: "Security", module: "Administration" },
    employee: { label: "Employee Profiles", group: "Employees", module: "Employees" },
    policy: { label: "Employment policies", group: "Employees", module: "Work Rules" },
    leave_request: { label: "Time Off", group: "Employees", module: "Time Off" },
    leave_type: { label: "Leave types", group: "Employees", module: "Time Off" },
    backdated_leave_entry: { label: "Backdated leave", group: "Employees", module: "Time Off" },
    attendance_record: { label: "Attendance", group: "Employees", module: "Time Off" },
    schedule: { label: "Scheduling", group: "Workforce", module: "Scheduling" },
    forecast: { label: "Forecasting", group: "Workforce", module: "Forecasting" },
    marketplace_post: { label: "Shift posts", group: "Workforce", module: "Scheduling" },
    marketplace_claim: { label: "Shift claims", group: "Workforce", module: "Scheduling" },
    swap_request: { label: "Shift swaps", group: "Workforce", module: "Scheduling" },
    bid_opportunity: { label: "Shift bids", group: "Workforce", module: "Scheduling" },
    compliance_rule: { label: "Compliance rules", group: "Governance", module: "Reports" },
    compliance_report: { label: "Compliance reports", group: "Governance", module: "Reports" },
    dashboard: { label: "Dashboards", group: "Governance", module: "Reports" },
    metric_definition: { label: "Metrics", group: "Governance", module: "Reports" },
    analytics_export: { label: "Exports", group: "Governance", module: "Reports" },
    webhook: { label: "Webhooks", group: "Integrations", module: "Administration" },
    webhook_subscription: { label: "Webhook subscriptions", group: "Integrations", module: "Administration" },
    integration_connector: { label: "Data Sources", group: "Integrations", module: "Administration" },
    reason_code: { label: "Reason Codes", group: "Integrations", module: "Administration" },
    data_source_group: { label: "Data Source Groups", group: "Integrations", module: "Administration" },
    historical_import: { label: "Historical Data Import", group: "Integrations", module: "Administration" },
    scorecard_source: { label: "Scorecards Sources", group: "Integrations", module: "Administration" },
    ai_provider_config: { label: "AI provider", group: "Integrations", module: "Administration" },
    ai_governance_policy: { label: "AI governance", group: "Integrations", module: "Administration" },
    ai_interaction: { label: "AI interactions", group: "Integrations", module: "Administration" },
    ai_recommendation: { label: "AI recommendations", group: "Integrations", module: "Administration" },
  };
export const metaFor = (resource) => RESOURCE_META[resource] || { label: resource, group: "Other", module: "Other" };
