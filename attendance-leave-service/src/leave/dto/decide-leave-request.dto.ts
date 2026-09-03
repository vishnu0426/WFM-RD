import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { LeaveRequestStatus } from '../entities/leave-request.entity';

/**
 * §3.1's `decideLeaveRequest` input. Only `approved`/`rejected` are valid
 * decisions - `pending`/`cancelled` are not something a decision produces.
 *
 * `actorPermissions` (Phase 6, ADR-0079): the same explicit,
 * client-supplied-actor-data posture this module has used since Phase 4's
 * `decidedBy` (no JWT/session verification exists anywhere in this
 * service) - a flat permission-string array the caller asserts the actor
 * holds. Only checked, and only required, when the request being decided
 * is `is_backdated` and the decision is `approved`
 * (`DecideLeaveRequestService.applyDecision`); omitted/empty is fine for
 * every ordinary decision, exactly as it was before this field existed.
 *
 * `reason` (Attendance & Leave Manager Views phase, §2): required on
 * `rejected`, forbidden-by-convention (though not rejected outright) on
 * `approved` - `@ValidateIf` scopes the `@IsNotEmpty` check to the reject
 * path only, matching §2's "a required comment field on reject."
 */
export class DecideLeaveRequestDto {
  @IsIn([LeaveRequestStatus.APPROVED, LeaveRequestStatus.REJECTED])
  decision!: LeaveRequestStatus.APPROVED | LeaveRequestStatus.REJECTED;

  @IsUUID()
  decidedBy!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  actorPermissions?: string[];

  @ValidateIf((dto: DecideLeaveRequestDto) => dto.decision === LeaveRequestStatus.REJECTED)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason?: string;
}
