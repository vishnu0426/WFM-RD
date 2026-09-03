/**
 * §4.3's subject grammar `agno.<domain>.<entity>.<event>.v<version>`, with a
 * per-employee-keyed suffix on `agent.state_changed` specifically (ADR-0063).
 * JetStream has no free Kafka-partition-key ordering, so §4.3's requirement
 * that "state changes for a given `employeeId` must be applied to Redis in
 * the order they were emitted" has to be designed into the subject itself,
 * not assumed - a Phase 2 consumer binds a filtered consumer per
 * employee-subject rather than racing one shared consumer across employees.
 * This also doubles as the frozen contract boundary for the module prompt's
 * flagged future Node→Go extraction (ADR-0063): whatever consumes these
 * subjects can be rewritten in another language without this service's
 * publishers changing at all.
 */
export const INTRADAY_STREAM_NAME = 'AGNO_INTRADAY_EVENTS';

export const INTRADAY_SUBJECTS = {
  AGENT_STATE_CHANGED_PREFIX: 'agno.intraday.agent.state_changed.v1',
  QUEUE_METRICS_UPDATED: 'agno.intraday.queue.metrics_updated.v1',
  REALLOCATION_SUGGESTED: 'agno.intraday.reallocation.suggested.v1',
  STAFFING_OFFER_CREATED: 'agno.intraday.staffing_offer.created.v1',
  DLQ: 'agno.intraday.dlq.v1',
} as const;

/** `agno.intraday.agent.state_changed.v1.{employeeId}` - see ADR-0063. */
export function agentStateChangedSubject(employeeId: string): string {
  return `${INTRADAY_SUBJECTS.AGENT_STATE_CHANGED_PREFIX}.${employeeId}`;
}

/**
 * §4.3's producer for this subject is the activity ingestion service (this
 * service). Phase 2's `AgentStateChangedConsumerService`
 * (`src/consumers/agent-state-changed.consumer.ts`) is the first real
 * consumer - it writes `currentActivity`/`activityStartedAt`/`siteId`/
 * `queueId` into `AgentLiveState`, nothing else.
 */
export interface AgentStateChangedPayload {
  tenantId: string;
  employeeId: string;
  sourceEventId: string;
  currentActivity: string;
  activityStartedAt: string;
  siteId: string | null;
  queueId: string | null;
  receivedAt: string;
}

/**
 * Phase 2 (ADR-0064/0065): scheduling-service's own stream/subjects -
 * intraday-service subscribes to a namespace it doesn't own, so these
 * constants are a documented, hardcoded cross-service coupling (matching
 * `scheduling-service/app/config.py`'s own `nats_stream_name` default) -
 * not dynamically discovered. If scheduling-service ever renames its
 * stream/subjects, this file has to be updated too.
 */
export const SCHEDULING_STREAM_NAME = 'AGNO_SCHEDULING';

export const SCHEDULING_SUBJECTS = {
  SCHEDULE_PUBLISHED: 'agno.scheduling.schedule.published.v1',
  ASSIGNMENT_CHANGED: 'agno.scheduling.assignment.changed.v1',
} as const;

/** Mirrors `scheduling-service/app/events/nats_publisher.py`'s `publish_schedule_published` payload shape. */
export interface SchedulePublishedPayload {
  tenantId: string;
  scheduleId: string;
  orgUnitId: string;
  publishedAt: string;
  employeeIds: string[];
}

/** Mirrors `scheduling-service/app/events/nats_publisher.py`'s `publish_assignment_changed` payload shape. */
export interface AssignmentChangedPayload {
  tenantId: string;
  scheduleId: string;
  assignmentId: string;
  employeeId: string;
  shiftStart: string;
  shiftEnd: string;
  reason: 'manual_override';
}

/**
 * §4.3's producer for `QUEUE_METRICS_UPDATED` is "the queue monitoring
 * service" - a component no phase of this module builds (it's meant to
 * come from outside this module's own scope, the same way
 * scheduling-service produces `SCHEDULING_SUBJECTS`). Phase 4 is the first
 * real *consumer* of it (`QueueMetricsUpdatedConsumerService`) - see that
 * file's own doc comment for why `QueueLiveState` was dead data until now.
 */
export interface QueueMetricsUpdatedPayload {
  tenantId: string;
  queueId: string;
  currentVolume: number;
  agentsAvailable: number;
  agentsOnCall: number;
  forecastedVolume: number | null;
  serviceLevelCurrent: number | null;
  serviceLevelTarget: number | null;
}

/**
 * Phase 6: this service's own producer role for `REALLOCATION_SUGGESTED`
 * (§4.3 - "producer: reallocation recommendation engine"), published by
 * `ReallocationRecommendationService` on every new `suggested` row.
 */
export interface ReallocationSuggestedPayload {
  tenantId: string;
  reallocationActionId: string;
  fromQueueId: string;
  toQueueId: string;
  affectedEmployeeIds: string[];
  reason: string;
}

/**
 * This service's producer role for `STAFFING_OFFER_CREATED`, published by
 * `StaffingOfferService` on every new `StaffingOffer` row - detection +
 * push-trigger only this phase, see that service's own doc comment.
 * mobile-ess-service subscribes to this cross-service (its own copy of
 * this interface lives in its `src/nats/subjects.ts`, same documented-
 * hardcoded-coupling posture `LeaveRequestApprovedPayload` already has
 * there for attendance-leave-service).
 */
export interface StaffingOfferCreatedPayload {
  tenantId: string;
  staffingOfferId: string;
  queueId: string;
  offerType: 'vto' | 'overtime';
  employeeId: string;
  reason: string;
}
