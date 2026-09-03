import { Field, ID, ObjectType } from '@nestjs/graphql';
import { OrgUnitType } from '../entities/org-unit-type.enum';
import { OrgUnitStatus } from '../entities/org-unit-status.enum';

/**
 * The nested-tree shape `orgHierarchy(rootId, asOfDate)` (§2.3, §3.1) and
 * `GET /v1/org-units/{id}/tree?as_of=` (§3.2) both return. Deliberately not
 * `OrgUnitGraphQLType` with its `children` resolved lazily field-by-field:
 * an as-of read is reconstructed once, in memory, from `OrgUnitHistory`
 * (ADR-0013) - there is no live row for a historical node to lazily resolve
 * fields against, so the whole subtree is eagerly nested here instead.
 */
@ObjectType('OrgUnitSnapshot')
export class OrgUnitSnapshotType {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  parentOrgUnitId!: string | null;

  @Field(() => OrgUnitType)
  type!: OrgUnitType;

  @Field()
  name!: string;

  @Field()
  timezone!: string;

  @Field()
  countryCode!: string;

  @Field(() => OrgUnitStatus)
  status!: OrgUnitStatus;

  @Field(() => [OrgUnitSnapshotType])
  children!: OrgUnitSnapshotType[];
}
