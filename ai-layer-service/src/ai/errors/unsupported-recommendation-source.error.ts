import { DomainError } from '../../common/errors/domain-error';

/** Only `source_module: 'intraday'` (reallocation) has a real execution pathway wired (docs/adr/0124) - `scheduling`/`forecasting` recommendations can be created and decided, but never auto-executed or approved-with-execution, until a real write-back client exists for them. */
export class UnsupportedRecommendationSourceError extends DomainError {
  constructor(sourceModule: string) {
    super(
      'UNSUPPORTED_RECOMMENDATION_SOURCE',
      `No execution pathway is wired for source_module "${sourceModule}" yet - it can be suggested and decided, but not executed.`,
    );
  }
}
