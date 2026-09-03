/** Per-queue trigger name, shared by the publish side (`QueueMetricsUpdatedConsumerService`) and the subscribe side (`QueueLiveStateResolver`) so they can never drift apart. */
export function queueLiveStateUpdatedTrigger(queueId: string): string {
  return `queueLiveStateUpdated:${queueId}`;
}

/**
 * Per-tenant trigger name, shared by `AlertPipelineService`/
 * `AlertEscalationSchedulerService` (publish side) and `AlertResolver`
 * (subscribe side). Keyed by tenant, not `orgUnitId` - no upstream payload
 * in this module carries `org_unit_id` (design doc assumption 5), same
 * limitation `activeAlerts(orgUnitId)` already has.
 */
export function alertRaisedTrigger(tenantId: string): string {
  return `alertRaised:${tenantId}`;
}

/** Per-tenant trigger name, shared by `ReallocationRecommendationService` (publish side) and `ReallocationResolver` (subscribe side) - `ReallocationAction` has no `org_unit_id` field at all (§2.1), an even more literal absence than `Alert`'s always-`null` one. */
export function reallocationSuggestedTrigger(tenantId: string): string {
  return `reallocationSuggested:${tenantId}`;
}
