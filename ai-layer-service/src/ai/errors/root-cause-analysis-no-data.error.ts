import { DomainError } from '../../common/errors/domain-error';

/**
 * Thrown when NEITHER data source (compliance's adherence rollup, nor
 * intraday's reallocation-churn list) has anything for the requested org
 * unit/period - distinct from either source individually having zero rows
 * (which is legitimate, unremarkable data, not an error). Non-negotiable
 * #2: with nothing to ground an answer in, the correct behavior is to say
 * so, not to let an LLM call happen with an empty/near-empty input_context.
 */
export class RootCauseAnalysisNoDataError extends DomainError {
  constructor(orgUnitId: string) {
    super(
      'ROOT_CAUSE_ANALYSIS_NO_DATA',
      `No adherence or reallocation data was found for org unit "${orgUnitId}" in the requested period.`,
    );
  }
}
