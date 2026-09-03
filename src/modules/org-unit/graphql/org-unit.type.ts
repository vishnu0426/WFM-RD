import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { OrgUnitType as OrgUnitTypeEnum } from '../entities/org-unit-type.enum';
import { OrgUnitStatus } from '../entities/org-unit-status.enum';

registerEnumType(OrgUnitTypeEnum, { name: 'OrgUnitType' });
registerEnumType(OrgUnitStatus, { name: 'OrgUnitStatus' });

/**
 * §3.1: id, name, type, parent, children, employees, asOfDate-aware
 * resolver. `parent`/`children`/`employees` are `@ResolveField`s on
 * `OrgUnitResolver` (lazy, current-state only) rather than plain fields
 * here - see that resolver for why `orgHierarchy`'s as-of reads use the
 * separate `OrgUnitSnapshot` type instead of this one.
 */
@ObjectType('OrgUnit')
export class OrgUnitGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  parentOrgUnitId!: string | null;

  @Field(() => OrgUnitTypeEnum)
  type!: OrgUnitTypeEnum;

  @Field()
  name!: string;

  @Field()
  timezone!: string;

  @Field()
  countryCode!: string;

  @Field(() => OrgUnitStatus)
  status!: OrgUnitStatus;
}
