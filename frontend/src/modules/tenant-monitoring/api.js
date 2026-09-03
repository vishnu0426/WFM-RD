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
