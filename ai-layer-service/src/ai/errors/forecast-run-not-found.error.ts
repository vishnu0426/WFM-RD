import { DomainError } from '../../common/errors/domain-error';

export class ForecastRunNotFoundError extends DomainError {
  constructor(forecastRunId: string) {
    super('FORECAST_RUN_NOT_FOUND', `No forecast run with id "${forecastRunId}" was found for this tenant.`);
  }
}
