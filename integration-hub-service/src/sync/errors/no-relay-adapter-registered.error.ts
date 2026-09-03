import { DomainError } from '../../common/errors/domain-error';

export class NoRelayAdapterRegisteredError extends DomainError {
  constructor(provider: string) {
    super(
      'NO_RELAY_ADAPTER_REGISTERED',
      `No streaming relay adapter is registered for provider "${provider}" - real provider adapters land in Phase 6/6b.`,
    );
  }
}
