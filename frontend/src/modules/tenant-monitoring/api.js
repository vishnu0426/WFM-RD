/* Typed client for the Tenant Monitoring dashboard. Two cross-tenant reads
   go to analytics-reporting-service (platform_admin-only, tenant_monitoring:
   read — see analytics-reporting-service/src/tenant-monitoring/rest/
   tenant-monitoring.controller.ts); tenant creation/provisioning goes to
   the root service instead — same platform_admin session, different
   backend service, see src/modules/tenant/rest/tenant-management.
   controller.ts. */
import { Api } from '../../core/api.js';

export function getOnboardingFunnel() {
  return Api.analyticsApi('/v1/tenant-monitoring/onboarding-funnel');
}

export function getHealth() {
  return Api.analyticsApi('/v1/tenant-monitoring/health');
}

export function listAllTenants() {
  return Api.rootApi('/v1/tenants/all');
}

export function getTenant(id) {
  return Api.rootApi(`/v1/tenants/${id}`);
}

export function createTenant(dto) {
  return Api.rootApi('/v1/tenants', { method: 'POST', body: dto });
}

export function provisionTenantAdmin(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/provision-admin`, { method: 'POST', body: dto });
}

export function getOrgUnitStatus(id) {
  return Api.rootApi(`/v1/tenants/${id}/org-units/exists`);
}

export function provisionOrgUnit(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/provision-org-unit`, { method: 'POST', body: dto });
}

export function getWfmDefaults(id) {
  return Api.rootApi(`/v1/tenants/${id}/wfm-defaults`);
}

export function updateWfmDefaults(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/wfm-defaults`, { method: 'PUT', body: dto });
}

/* integration-hub-service, not the root service — a genuinely different
   backend. Read-only: see TenantConnectorsController's own doc comment for
   why there's no create call here — connector creation always requires
   real Vault-bound credentials, which this onboarding step deliberately
   doesn't collect. */
export function getConnectorStatus(id) {
  return Api.integrationHubApi(`/v1/tenants/${id}/connectors/exists`);
}

export function listFeatureFlagForAllTenants(flagKey) {
  return Api.rootApi(`/v1/feature-flags/${encodeURIComponent(flagKey)}`);
}

export function setFeatureFlagForTenant(flagKey, tenantId, enabled) {
  return Api.rootApi(`/v1/feature-flags/${encodeURIComponent(flagKey)}/tenants/${tenantId}`, {
    method: 'PUT',
    body: { enabled },
  });
}

/* Platform Admin's cross-tenant System Configuration
   (TenantConfigAdminController, src/modules/tenant/rest/tenant-config-admin.controller.ts)
   — same underlying TenantSettings/Policy/NotificationRule rows the
   tenant's own /v1/tenant-settings self-service routes read/write, just
   reached via a platform_admin-gated :id-scoped sibling. */
export function getTenantConfigGeneral(id) {
  return Api.rootApi(`/v1/tenants/${id}/config/general`);
}
export function updateTenantConfigGeneral(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/config/general`, { method: 'PUT', body: dto });
}
export function getTenantConfigSecurity(id) {
  return Api.rootApi(`/v1/tenants/${id}/config/security`);
}
export function updateTenantConfigSecurity(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/config/security`, { method: 'PUT', body: dto });
}
export function getTenantConfigEmail(id) {
  return Api.rootApi(`/v1/tenants/${id}/config/email`);
}
export function updateTenantConfigEmail(id, dto) {
  return Api.rootApi(`/v1/tenants/${id}/config/email`, { method: 'PUT', body: dto });
}
export function testTenantConfigEmail(id) {
  return Api.rootApi(`/v1/tenants/${id}/config/email/test-connection`, { method: 'POST' });
}
export function getTenantConfigPolicy(id, policyType) {
  return Api.rootApi(`/v1/tenants/${id}/config/${policyType}`);
}
export function setTenantConfigPolicy(id, policyType, policyGroupId, definition) {
  return Api.rootApi(`/v1/tenants/${id}/config/${policyType}`, {
    method: 'POST',
    body: { policyGroupId: policyGroupId || undefined, definition },
  });
}
export function listTenantConfigNotificationRules(id) {
  return Api.rootApi(`/v1/tenants/${id}/config/notification-rules`);
}
export function setTenantConfigNotificationRule(id, eventType, channel, enabled) {
  return Api.rootApi(`/v1/tenants/${id}/config/notification-rules/${encodeURIComponent(eventType)}/${channel}`, {
    method: 'PUT',
    body: { enabled },
  });
}

/* Platform Settings (PlatformSettingsController, src/modules/platform-settings/
   rest/platform-settings.controller.ts) — genuinely platform-wide, no
   tenant in the URL at all, unlike everything above this comment. */
export function getPlatformFeatureFlagDefaults() {
  return Api.rootApi('/v1/platform-settings/feature-flag-defaults');
}
export function setPlatformFeatureFlagDefault(flagKey, enabled) {
  return Api.rootApi(`/v1/platform-settings/feature-flag-defaults/${encodeURIComponent(flagKey)}`, {
    method: 'PUT',
    body: { enabled },
  });
}
export function getPlatformSmtpSettings() {
  return Api.rootApi('/v1/platform-settings/smtp');
}
export function updatePlatformSmtpSettings(dto) {
  return Api.rootApi('/v1/platform-settings/smtp', { method: 'PUT', body: dto });
}
export function testPlatformSmtpConnection() {
  return Api.rootApi('/v1/platform-settings/smtp/test-connection', { method: 'POST' });
}
export function getPlatformSecurityBaseline() {
  return Api.rootApi('/v1/platform-settings/security-baseline');
}
export function updatePlatformSecurityBaseline(dto) {
  return Api.rootApi('/v1/platform-settings/security-baseline', { method: 'PUT', body: dto });
}
