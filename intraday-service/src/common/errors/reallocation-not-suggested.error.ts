import { DomainError } from './domain-error';
import { ReallocationStatus } from '../../reallocation/entities/reallocation-action.entity';

/** Thrown by `approveReallocation` when the row isn't in `status: 'suggested'` any more - already approved/rejected/executed. A real state conflict, not a silent no-op. */
export class ReallocationNotSuggestedError extends DomainError {
  readonly code = 'REALLOCATION_NOT_SUGGESTED';

  constructor(reallocationId: string, currentStatus: ReallocationStatus) {
    super(`Reallocation action ${reallocationId} is not pending approval (current status: ${currentStatus})`);
  }
}
