import { IsIn, IsOptional, IsString } from 'class-validator';
import { TenantTier } from '../entities/tenant-tier.enum';
import { TenantStatus } from '../entities/tenant-status.enum';

/**
 * §3.2's `PUT /v1/tenants/{id}` - partial update. Status transitions
 * (`active` -> `suspended` -> `deprovisioned`, ...) are not state-machine
 * validated here - `TenantsRepository.update`'s underlying `tenants_update`
 * RLS policy gates *who* may change a tenant, not *which* status values are
 * reachable from which. A real deployment likely wants that validated
 * (§0.5); flagged as an explicit gap rather than guessed at, since the
 * spec doesn't name the allowed transition graph.
 */
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(Object.values(TenantTier))
  tier?: TenantTier;

  @IsOptional()
  @IsIn(Object.values(TenantStatus))
  status?: TenantStatus;

  @IsOptional()
  @IsString()
  dataResidencyRegion?: string;
}
