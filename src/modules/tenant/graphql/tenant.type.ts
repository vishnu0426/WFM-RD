import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { TenantTier } from '../entities/tenant-tier.enum';
import { TenantStatus } from '../entities/tenant-status.enum';

registerEnumType(TenantTier, { name: 'TenantTier' });
registerEnumType(TenantStatus, { name: 'TenantStatus' });

/** §3.2's GraphQL BFF (Phase 6) - read-only mirror of the REST `/v1/tenants` shape (ADR-0045). */
@ObjectType('Tenant')
export class TenantGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  parentTenantId!: string | null;

  @Field(() => TenantTier)
  tier!: TenantTier;

  @Field()
  dataResidencyRegion!: string;

  @Field(() => TenantStatus)
  status!: TenantStatus;
}
