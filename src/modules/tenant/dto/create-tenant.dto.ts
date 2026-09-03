import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { TenantTier } from '../entities/tenant-tier.enum';

/**
 * §3.2's `POST /v1/tenants` - onboards a child tenant under the caller's own
 * tenant (BPO multi-client onboarding) or, for a platform-admin session, any
 * tenant including a new top-level one. `parentTenantId` omitted means
 * "under my own tenant" for a BPO caller - `TenantsRepository.create`'s
 * underlying `tenants_insert` RLS policy is the actual gate either way (see
 * that repository's doc comment); this DTO only validates shape.
 *
 * `slug`/`industry`/`country`/`currency`/`language` are Platform Admin
 * onboarding's Company Information step (only `slug` required - the others
 * are opportunistic detail, same "don't force complete config at creation"
 * posture the whole onboarding flow takes elsewhere). `slug` uniqueness
 * itself is checked in the controller (`TenantsRepository.findBySlug`),
 * not here - this DTO only validates shape.
 */
export class CreateTenantDto {
  @IsString()
  name!: string;

  @IsIn(Object.values(TenantTier))
  tier!: TenantTier;

  @IsString()
  dataResidencyRegion!: string;

  @IsOptional()
  @IsUUID()
  parentTenantId?: string;

  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase alphanumeric segments separated by hyphens' })
  @Length(1, 63)
  slug!: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @Length(2, 2)
  country?: string;

  @IsOptional()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  language?: string;
}
