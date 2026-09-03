import { DomainError } from '../../../common/errors/domain-error';
import { TenantStatus } from '../entities/tenant-status.enum';

/** `POST /v1/tenants/:id/provision-admin` only ever targets a brand-new tenant still in `PROVISIONING` — not a general "add an admin to any existing tenant" tool. Same shared `INVALID_STATE_TRANSITION` code `ErasureRequestInvalidTransitionError` already uses, not a bespoke one. */
export class TenantNotProvisioningError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(id: string, actualStatus: TenantStatus) {
    super(`Tenant ${id} is not awaiting provisioning (current status: '${actualStatus}').`, { id, actualStatus });
  }
}
