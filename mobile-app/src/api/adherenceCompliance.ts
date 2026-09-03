import { graphqlRequest } from './client';
import { AdherenceScoreToday } from './types';

const ADHERENCE_SCORE_TODAY_QUERY = `
  query AdherenceScoreToday($employeeId: ID!) {
    adherenceScoreToday(employeeId: $employeeId) {
      employeeId
      periodStart
      periodEnd
      adherencePct
      majorDeviationCount
      adherentSeconds
      totalScheduledSeconds
      computedAt
    }
  }
`;

/**
 * adherence-compliance-service's precomputed, time-weighted "today so
 * far" adherence percentage (docs/adr/0156) — `null` means the employee
 * has had no adherence activity recorded yet today, not a `0%`.
 */
export async function getAdherenceScoreToday(params: {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
}): Promise<AdherenceScoreToday | null> {
  const data = await graphqlRequest<{ adherenceScoreToday: AdherenceScoreToday | null }>(
    params.apiBaseUrl,
    ADHERENCE_SCORE_TODAY_QUERY,
    { employeeId: params.employeeId },
    params.tenantId,
  );
  return data.adherenceScoreToday;
}
