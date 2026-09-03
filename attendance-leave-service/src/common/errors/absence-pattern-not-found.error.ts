import { DomainError } from './domain-error';

export class AbsencePatternNotFoundError extends DomainError {
  constructor(id: string) {
    super('ABSENCE_PATTERN_NOT_FOUND', `AbsencePattern ${id} was not found for this tenant.`);
  }
}
