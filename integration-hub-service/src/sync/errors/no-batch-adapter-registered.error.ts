import { DomainError } from '../../common/errors/domain-error';

export class NoBatchAdapterRegisteredError extends DomainError {
  constructor(provider: string) {
    super(
      'NO_BATCH_ADAPTER_REGISTERED',
      `No batch connector adapter is registered for provider "${provider}" - real provider adapters land in Phase 3/6b.`,
    );
  }
}
