import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { VaultModule } from '../vault/vault.module';
import { IntegrationConnectorsModule } from '../connectors/integration-connectors.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AuthModule } from '../auth/auth.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { SyncJobsService } from './sync-jobs.service';
import { ProviderRateLimitConfigService } from './provider-rate-limit-config.service';
import { BATCH_CONNECTOR_ADAPTERS } from './batch/batch-connector-adapter';
import { BatchAdapterRegistry } from './batch/batch-adapter-registry.service';
import { RateLimiterService } from './batch/rate-limiter.service';
import { BatchSyncRunnerService } from './batch/batch-sync-runner.service';
import { BatchSyncController } from './batch/batch-sync.controller';
import { BulkImportClientService } from './batch/providers/bulk-import-client.service';
import { WorkdayAdapter } from './batch/providers/workday.adapter';
import { SapSuccessFactorsAdapter } from './batch/providers/sap-successfactors.adapter';
import { AdpAdapter } from './batch/providers/adp.adapter';
import { SalesforceAdapter } from './batch/providers/salesforce.adapter';
import { STREAMING_RELAY_ADAPTERS } from './relay/streaming-relay-adapter';
import { RelayAdapterRegistry } from './relay/relay-adapter-registry.service';
import { StreamingRelayService } from './relay/streaming-relay.service';
import { RelayController } from './relay/relay.controller';
import { IntradayActivityEventClient } from './relay/providers/intraday-activity-event-client';
import { GenesysCloudAdapter } from './relay/providers/genesys-cloud.adapter';
import { NiceCxoneAdapter } from './relay/providers/nice-cxone.adapter';
import { Five9Adapter } from './relay/providers/five9.adapter';
import { TalkdeskAdapter } from './relay/providers/talkdesk.adapter';
import { AxpAdapter } from './relay/providers/axp.adapter';
import { AvayaAuraAdapter } from './relay/providers/avaya-aura.adapter';

/**
 * Phase 2 (§7): both the batch-runner base and the streaming-relay base.
 * Phase 3 populates `BATCH_CONNECTOR_ADAPTERS` with the first real adapter,
 * `WorkdayAdapter`; Phase 6 does the same for `STREAMING_RELAY_ADAPTERS`
 * with the first real streaming adapter, `GenesysCloudAdapter` - both by
 * overriding the provider's `useFactory`, not by editing
 * `BatchSyncRunnerService`/`BatchAdapterRegistry`/`StreamingRelayService`
 * themselves. Phase 6b extends both lists with the remaining researched
 * providers (ADR-0142: Avaya is deliberately not among them).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    TenantContextModule,
    MetricsModule,
    VaultModule,
    IntegrationConnectorsModule,
    WebhooksModule,
    AuthModule,
  ],
  controllers: [BatchSyncController, RelayController],
  providers: [
    migratorPoolProvider,
    SyncJobsService,
    ProviderRateLimitConfigService,
    RateLimiterService,
    BulkImportClientService,
    WorkdayAdapter,
    SapSuccessFactorsAdapter,
    AdpAdapter,
    SalesforceAdapter,
    {
      provide: BATCH_CONNECTOR_ADAPTERS,
      useFactory: (
        workday: WorkdayAdapter,
        sap: SapSuccessFactorsAdapter,
        adp: AdpAdapter,
        salesforce: SalesforceAdapter,
      ) => [workday, sap, adp, salesforce],
      inject: [WorkdayAdapter, SapSuccessFactorsAdapter, AdpAdapter, SalesforceAdapter],
    },
    BatchAdapterRegistry,
    BatchSyncRunnerService,
    IntradayActivityEventClient,
    GenesysCloudAdapter,
    NiceCxoneAdapter,
    Five9Adapter,
    TalkdeskAdapter,
    AxpAdapter,
    AvayaAuraAdapter,
    {
      provide: STREAMING_RELAY_ADAPTERS,
      useFactory: (
        genesys: GenesysCloudAdapter,
        nice: NiceCxoneAdapter,
        five9: Five9Adapter,
        talkdesk: TalkdeskAdapter,
        axp: AxpAdapter,
        avayaAura: AvayaAuraAdapter,
      ) => [genesys, nice, five9, talkdesk, axp, avayaAura],
      inject: [GenesysCloudAdapter, NiceCxoneAdapter, Five9Adapter, TalkdeskAdapter, AxpAdapter, AvayaAuraAdapter],
    },
    RelayAdapterRegistry,
    StreamingRelayService,
  ],
  exports: [SyncJobsService, BatchSyncRunnerService],
})
export class SyncModule {}
