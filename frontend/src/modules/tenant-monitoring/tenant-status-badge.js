/* Badge for core.tenants.status values (TenantStatus enum: active,
   suspended, provisioning, deprovisioned) — shared by both Tenant
   Monitoring screens. identity-org/shared/ui.js's stBadge() doesn't cover
   these (it's employee/role/request statuses), so this is its own small
   map rather than falling through to a mismatched generic badge. */
export function tenantStatusBadge(status) {
  const map = {
    active: ['badge-ok', 'Active'],
    suspended: ['badge-danger', 'Suspended'],
    provisioning: ['badge-warn', 'Provisioning'],
    deprovisioned: ['badge-off', 'Deprovisioned'],
  };
  const [c, l] = map[status] || ['badge-sys', status];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}
