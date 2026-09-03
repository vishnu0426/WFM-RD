import { Field, InputType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { OrgUnitStatus } from '../entities/org-unit-status.enum';

/**
 * Reparenting (changing `parentOrgUnitId`) and archiving (`status:
 * ARCHIVED`) both go through this one mutation rather than dedicated
 * `moveOrgUnit`/`archiveOrgUnit` mutations - §2.2 rule 4 doesn't name
 * separate operations, and `org.fn_org_unit_recompute_path_on_update` /
 * `org.fn_org_unit_history_track` (Phase 1) already handle both as ordinary
 * column changes. `type` is intentionally not updatable here: §2.1 gives no
 * indication an org unit's structural type changes post-creation, and
 * allowing it would need its own cross-field validation this phase doesn't
 * have a stated requirement to build.
 */
@InputType()
export class UpdateOrgUnitInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentOrgUnitId?: string | null;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  timezone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @Field(() => OrgUnitStatus, { nullable: true })
  @IsOptional()
  @IsEnum(OrgUnitStatus)
  status?: OrgUnitStatus;

  /**
   * GAP-07 fix (enterprise readiness audit, 2026-08-18): when supplied, the
   * resulting `OrgUnitHistory` version is dated as of this timestamp
   * instead of "now" - a backdated correction or a future-dated scheduled
   * reorg, not just an as-of-today edit. Omitted = effective now
   * (unchanged default behavior). Never persisted onto `OrgUnit` itself -
   * `OrgUnitsService.update` strips it from the column-update payload.
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
