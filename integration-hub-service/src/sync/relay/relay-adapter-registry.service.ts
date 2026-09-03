import { Inject, Injectable } from '@nestjs/common';
import { STREAMING_RELAY_ADAPTERS, StreamingRelayAdapter } from './streaming-relay-adapter';

@Injectable()
export class RelayAdapterRegistry {
  private readonly byProvider: Map<string, StreamingRelayAdapter>;

  constructor(@Inject(STREAMING_RELAY_ADAPTERS) adapters: StreamingRelayAdapter[]) {
    this.byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  find(provider: string): StreamingRelayAdapter | undefined {
    return this.byProvider.get(provider);
  }
}
