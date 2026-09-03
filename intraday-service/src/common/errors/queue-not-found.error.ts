import { DomainError } from './domain-error';

/** Thrown by the REST snapshot fallback (`LiveStateRestController`) - the GraphQL `queueLiveState` query returns `null` instead, the idiomatic GraphQL shape for "no data." */
export class QueueNotFoundError extends DomainError {
  readonly code = 'QUEUE_NOT_FOUND';

  constructor(queueId: string) {
    super(`No live state for queue ${queueId}`);
  }
}
