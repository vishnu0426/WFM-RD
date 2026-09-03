import { Module } from '@nestjs/common';
import { VaultModule } from '../vault/vault.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';
import { AuditGrpcClientModule } from '../grpc/audit-grpc-client.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { IntegrationConnectorsService } from './integration-connectors.service';
import { OAuthTokenExchangeService } from './oauth-token-exchange.service';
import { OAuthCallbackController } from './oauth-callback.controller';
import { TenantConnectorsController } from './rest/tenant-connectors.controller';
import { FieldMappingsService } from './field-mappings.service';
import { FieldAuthorityPoliciesService } from './field-authority-policies.service';

@Module({
  // AuthModule imported for TenantConnectorsController's guard trio, and
  // AccessTokenGuard/PermissionsGuard/PlatformAdminGuard re-listed in this
  // module's own providers alongside it - a guard referenced via
  // @UseGuards(...) resolves through the *consuming* module's own
  // injector, not the module that originally provided it (same fix the
  // root service's AnalyticsModule/TenantMonitoringModule already needed;
  // importing AuthModule alone isn't enough, confirmed live here too - the
  // app failed to boot without this).
  imports: [VaultModule, TenantContextModule, MetricsModule, AuthModule, AuditGrpcClientModule],
  controllers: [OAuthCallbackController, TenantConnectorsController],
  providers: [
    IntegrationConnectorsService,
    OAuthTokenExchangeService,
    FieldMappingsService,
    FieldAuthorityPoliciesService,
    AccessTokenGuard,
    PermissionsGuard,
    PlatformAdminGuard,
  ],
  exports: [IntegrationConnectorsService, FieldMappingsService, FieldAuthorityPoliciesService],
})
export class IntegrationConnectorsModule {}
