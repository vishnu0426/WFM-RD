import { DomainError } from './domain-error';

/** Thrown by `acknowledgeAlert` when `alertId` doesn't exist (or belongs to another tenant - RLS makes the two indistinguishable, which is correct). */
export class AlertNotFoundError extends DomainError {
  readonly code = 'ALERT_NOT_FOUND';

  constructor(alertId: string) {
    super(`No alert found with id ${alertId}`);
  }
}
