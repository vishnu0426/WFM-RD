import { Inject, Injectable, Optional } from '@nestjs/common';
import { HISTORICAL_CONNECTOR_ADAPTERS, HistoricalConnectorAdapter } from './historical-connector-adapter';

/** Same shape as `BatchAdapterRegistry` - see `historical-connector-adapter.ts`'s own doc comment for why this is (correctly) empty today. */
@Injectable()
export class HistoricalAdapterRegistry {
  private readonly byProvider: Map<string, HistoricalConnectorAdapter>;

  constructor(@Optional() @Inject(HISTORICAL_CONNECTOR_ADAPTERS) adapters: HistoricalConnectorAdapter[] = []) {
    this.byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  find(provider: string): HistoricalConnectorAdapter | undefined {
    return this.byProvider.get(provider);
  }
}
