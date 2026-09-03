import { Inject, Injectable } from '@nestjs/common';
import { BATCH_CONNECTOR_ADAPTERS, BatchConnectorAdapter } from './batch-connector-adapter';

@Injectable()
export class BatchAdapterRegistry {
  private readonly byProvider: Map<string, BatchConnectorAdapter>;

  constructor(@Inject(BATCH_CONNECTOR_ADAPTERS) adapters: BatchConnectorAdapter[]) {
    this.byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  find(provider: string): BatchConnectorAdapter | undefined {
    return this.byProvider.get(provider);
  }
}
