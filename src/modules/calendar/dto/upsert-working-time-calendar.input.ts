import { Field, InputType } from '@nestjs/graphql';
import { IsArray, IsObject, IsOptional, IsString, IsUUID, Length, MinLength } from 'class-validator';

/**
 * §3.2's `POST /v1/calendars` ("create/update") - one DTO for both, keyed by
 * `orgUnitId` (`null`/omitted = the tenant-wide default calendar). Used as
 * the REST request body (`class-validator` alone) and, via
 * `@InputType()`, also usable from GraphQL if a future phase wants a
 * mutation here - §3.1 doesn't name one, so none is added yet (REST is the
 * named surface for calendars per §3.2).
 */
@InputType()
export class UpsertWorkingTimeCalendarInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @Field()
  @Length(2, 2)
  countryCode!: string;

  /**
   * Not validated against the IANA zone database here (a full enumeration
   * would need `Intl.supportedValuesOf`, unavailable in this project's TS
   * lib target) - `SkillDecaySchedulerService.safeZone` (Phase 4, ADR-0017)
   * already tolerates an unrecognized zone by falling back to UTC and
   * logging a warning, so an unvalidated bad value here degrades safely
   * rather than corrupting scheduling.
   */
  @Field()
  @IsString()
  @MinLength(1)
  timezone!: string;

  @Field(() => [String])
  @IsArray()
  holidayDates!: string[];

  @Field(() => Object)
  @IsObject()
  standardBusinessHours!: Record<string, unknown>;
}
