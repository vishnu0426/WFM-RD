import { Field, ObjectType } from '@nestjs/graphql';
import { OrgUnitGraphQLType } from '../../org-unit/graphql/org-unit.type';

/**
 * Phase 0 frontend foundation addition: resolved ABAC scope for `me`/`user`,
 * so a client can build an org-unit picker/filter that only ever offers
 * choices the caller is actually scoped to - rather than listing the whole
 * tenant's org tree and letting a query/mutation reject an out-of-scope
 * choice after the fact. This is visibility only; `AbacService`'s own
 * per-request enforcement (exact org-unit match against
 * `UserRole.scopeOrgUnitId`) is unchanged and remains the real gate - a
 * client-side picker narrowing its own options is a UX courtesy, same as
 * every other RBAC-driven UI decision in this console.
 *
 * `isTenantWide` is true if any of the caller's role assignments carry
 * `scopeOrgUnitId: null` (a tenant-wide grant) - in that case `orgUnits`
 * still lists whatever *specific* scoped grants also exist (a user can hold
 * both), but a tenant-wide client should treat itself as unrestricted
 * rather than narrowed to just that list.
 */
@ObjectType('OrgUnitScope')
export class OrgUnitScopeGraphQLType {
  @Field()
  isTenantWide!: boolean;

  @Field(() => [OrgUnitGraphQLType])
  orgUnits!: OrgUnitGraphQLType[];
}
