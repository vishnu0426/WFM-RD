/**
 * `AGNO_AI_LAYER_EVENTS` stream subjects (`scripts/provision-nats-streams.ts`,
 * provisioned in Phase 2, unpublished-to until this phase) - grammar
 * matches every other service's own subject constants (`agno.<domain>.<entity>.<event>.v<version>`).
 */
export const AI_RECOMMENDATION_CREATED_SUBJECT = 'agno.ai.recommendation.created.v1';
export const AI_RECOMMENDATION_DECIDED_SUBJECT = 'agno.ai.recommendation.decided.v1';
