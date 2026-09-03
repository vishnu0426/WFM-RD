import { IsDateString, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * §3.1/§5.1's `submitBackdatedLeave` - a separate mutation from
 * `RequestLeaveDto`, not an overload of it, so the stricter audit path
 * can't be silently bypassed by a client that just calls the generic
 * endpoint with a past date (§3.1's own wording; enforced by
 * `LeaveRequestService.requestLeave` rejecting any past `dateRangeStart`
 * outright since Phase 3, and this endpoint rejecting anything that
 * *isn't* past - the two input domains are disjoint by construction).
 *
 * `backdatedReason` is mandatory (§5.1: "a mandatory `backdated_reason`,
 * free text, required not optional") - `@IsNotEmpty` rejects both a missing
 * field and an empty/whitespace-only string, not just a missing key.
 */
export class SubmitBackdatedLeaveDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  leaveTypeId!: string;

  /** `YYYY-MM-DD` - must resolve to a date strictly before today (UTC); enforced in `LeaveRequestService.submitBackdatedLeave`, not here (that check needs "today," which a DTO validator can't parameterize per-request without a custom validator class disproportionate to this one call site). */
  @IsDateString({ strict: true })
  dateRangeStart!: string;

  @IsDateString({ strict: true })
  dateRangeEnd!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  backdatedReason!: string;
}
