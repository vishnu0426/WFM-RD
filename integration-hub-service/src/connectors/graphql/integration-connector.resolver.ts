import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { IntegrationConnectorsService, Actor } from '../integration-connectors.service';
import { ConnectorType } from '../../integrations/entities/integration-connector.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import { AccessTokenClaims } from '../../auth/access-token.guard';
import {
  ConnectorTestResultType,
  CreateConnectorResultType,
  IntegrationConnectorResult,
  toCreateConnectorResultType,
  toIntegrationConnectorResult,
} from './types';

function actorFromClaims(claims: AccessTokenClaims | undefined): Actor {
  return { id: claims?.sub ?? null, type: 'user' };
}

/**
 * §3.1. `connectors` derives its tenant from `TenantContextService`
 * (ADR-0014's header-trust placeholder today, a verified JWT claim once
 * Module 01 identity is wired in) rather than accepting a client-supplied
 * `tenantId` argument the way §3.1's literal wording shows - the same
 * "never trust a client-supplied tenant id" posture every other resolver in
 * this platform already follows (e.g. `ai-layer-service`'s
 * `aiProviderConfig`). A deviation from the literal spec text, not from its
 * intent.
 *
 * `createConnector`'s OAuth fields are individual nullable `@Args()`, not a
 * composed `@InputType()` - own copy of `ai-layer-service`'s
 * `configureAiProvider` precedent ("no separate `@InputType()` seen for
 * mutations here"), and for a concrete reason found by this phase's own
 * real end-to-end verification: a composed nullable input-type argument
 * gets instantiated and validated by the global `ValidationPipe` even when
 * the client omits it entirely (a real NestJS/class-validator interaction,
 * not a hypothetical - it turned every omitted `oauth` argument into either
 * a false "both credentials and oauth provided" rejection or a batch of
 * "clientId must be a string" errors, neither reproducible by a resolver
 * unit test that calls this method directly with `undefined`). Individual
 * scalar `@Args()` never enter class-transformer/class-validator at all
 * when omitted, sidestepping the issue entirely.
 */
@Resolver(() => IntegrationConnectorResult)
export class IntegrationConnectorResolver {
  constructor(
    private readonly connectors: IntegrationConnectorsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => [IntegrationConnectorResult], { name: 'connectors' })
  async connectors_(): Promise<IntegrationConnectorResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.connectors.findAllForTenant(tenantId);
    return rows.map(toIntegrationConnectorResult);
  }

  /**
   * §7 Phase 8 (ADR-0145): the highest-credential-risk write in this
   * module's whole schema - a connector's `config` ultimately holds a
   * Vault reference to a real HRIS/payroll/CRM/ACD credential
   * (ADR-0134). Gated first, ahead of every other mutation, the same
   * "gate the specific escalating risk, not everything at once" scoping
   * ai-layer-service's own ADR-0130 applied to its two admin-config
   * mutations.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Mutation(() => CreateConnectorResultType)
  async createConnector(
    @Args('connectorType', { type: () => ConnectorType }) connectorType: ConnectorType,
    @Args('provider') provider: string,
    @Args('credentials', { type: () => Object, nullable: true }) credentials?: Record<string, unknown>,
    @Args('additionalConfig', { type: () => Object, nullable: true }) additionalConfig?: Record<string, unknown>,
    @Args('oauthClientId', { nullable: true }) oauthClientId?: string,
    @Args('oauthClientSecret', { nullable: true }) oauthClientSecret?: string,
    @Args('oauthAuthorizationEndpoint', { nullable: true }) oauthAuthorizationEndpoint?: string,
    @Args('oauthTokenEndpoint', { nullable: true }) oauthTokenEndpoint?: string,
    @Args('oauthRedirectUri', { nullable: true }) oauthRedirectUri?: string,
    @Args('oauthScope', { nullable: true }) oauthScope?: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<CreateConnectorResultType> {
    const tenantId = this.tenantContext.requireTenantId();
    const oauth = oauthClientId
      ? {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret ?? '',
          authorizationEndpoint: oauthAuthorizationEndpoint ?? '',
          tokenEndpoint: oauthTokenEndpoint ?? '',
          redirectUri: oauthRedirectUri ?? '',
          scope: oauthScope,
        }
      : undefined;
    const result = await this.connectors.create(
      tenantId,
      { connectorType, provider, credentials, additionalConfig, oauth },
      actorFromClaims(claims),
    );
    return toCreateConnectorResultType(result);
  }

  /**
   * WP1: real backend persistence for "Data Source Settings" (decision
   * #1) - `settings` is validated server-side (`validateConnectorSettings`)
   * against the whitelist in `config-schemas.ts`, never a raw passthrough.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Mutation(() => IntegrationConnectorResult)
  async updateConnectorSettings(
    @Args('connectorId', { type: () => ID }) connectorId: string,
    @Args('settings', { type: () => Object }) settings: Record<string, unknown>,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<IntegrationConnectorResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const connector = await this.connectors.updateSettings(tenantId, connectorId, settings, actorFromClaims(claims));
    return toIntegrationConnectorResult(connector);
  }

  /**
   * Soft delete - see `ConnectorStatus.DISABLED`'s own doc comment. Its
   * own permission (`integration_connector:delete`), not `:write` - the
   * spec's own RBAC section treats "Data Source Delete" as a distinct,
   * separately grantable action from update, and this is the module's
   * only irreversible-in-the-UI connector action.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:delete')
  @Mutation(() => IntegrationConnectorResult)
  async deleteConnector(
    @Args('connectorId', { type: () => ID }) connectorId: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<IntegrationConnectorResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const connector = await this.connectors.disable(tenantId, connectorId, actorFromClaims(claims));
    return toIntegrationConnectorResult(connector);
  }

  /**
   * Read-only diagnostic (`:read`, not `:write`) - verifies the stored
   * credential is present/readable in Vault; see
   * `IntegrationConnectorsService.testConnection`'s own doc comment for
   * exactly what this does and does not verify.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Mutation(() => ConnectorTestResultType)
  async testConnector(@Args('connectorId', { type: () => ID }) connectorId: string): Promise<ConnectorTestResultType> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.connectors.testConnection(tenantId, connectorId);
  }
}
