import { DomainError } from '../../common/errors/domain-error';

export class ScheduleJobNotFoundError extends DomainError {
  constructor(jobId: string) {
    super('SCHEDULE_JOB_NOT_FOUND', `No schedule job with id "${jobId}" was found for this tenant.`);
  }
}
