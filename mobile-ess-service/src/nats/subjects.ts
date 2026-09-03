/**
 * Cross-service constants mirroring `attendance-leave-service/src/nats/subjects.ts`
 * exactly (ADR-0154) - the same documented-hardcoded-coupling posture
 * `intraday-service`'s own `SCHEDULING_SUBJECTS` already accepts for its
 * cross-service subscription. If attendance-leave-service ever renames
 * this subject/stream or changes the payload shape, this file has to be
 * updated too - there is no shared package these are generated from.
 */
export const ATTENDANCE_LEAVE_STREAM_NAME = 'AGNO_ATTENDANCE_LEAVE_EVENTS';

export const ATTENDANCE_LEAVE_SUBJECTS = {
  LEAVE_REQUEST_APPROVED: 'agno.leave.request.approved.v1',
} as const;

export interface LeaveRequestApprovedPayload {
  tenantId: string;
  leaveRequestId: string;
  employeeId: string;
  leaveTypeId: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  decidedAt: string;
  decidedBy: string;
}

/**
 * Cross-service constants mirroring `intraday-service/src/nats/subjects.ts`
 * exactly - same documented-hardcoded-coupling posture as
 * `ATTENDANCE_LEAVE_SUBJECTS` above, for the "detection + push-trigger
 * only" VTO/overtime offer feature (`StaffingOfferService` in
 * intraday-service is the producer).
 */
export const INTRADAY_STREAM_NAME = 'AGNO_INTRADAY_EVENTS';

export const INTRADAY_SUBJECTS = {
  STAFFING_OFFER_CREATED: 'agno.intraday.staffing_offer.created.v1',
} as const;

export interface StaffingOfferCreatedPayload {
  tenantId: string;
  staffingOfferId: string;
  queueId: string;
  offerType: 'vto' | 'overtime';
  employeeId: string;
  reason: string;
}
