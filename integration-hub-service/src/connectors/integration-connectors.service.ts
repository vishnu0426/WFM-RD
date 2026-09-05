import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { VaultClientService } from '../vault/vault-client.service';
import { VaultSecretNotFoundError, VaultUnavailableError } from '../vault/vault.errors';
import {
  ConnectorStatus,
  ConnectorType,
  IntegrationConnector,
} from '../integrations/entities/integration-connector.entity';
import { assertNoRawCredentialMaterial } from './credential-shape-guard';
import { generateOAuthState, parseOAuthState } from './oauth-state';
import { validateConnectorSettings } from './config-schemas';
import { InvalidCreateConnectorInputError } from './errors/invalid-create-connector-input.error';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { ConnectorNotPendingOAuthSetupError, OAuthStateMismatchError } from './errors/oauth-callback.errors';
import { OAuthTokenExchangeService } from './oauth-token-exchange.service';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';

export interface ConnectionTestResult {
  ok: boolean;
  checkedAt: Date;
  detail: string;
}

/** `actorId: null` maps to audit.proto's own "empty string = null" convention (`AuditGrpcClientService` request shape) - never fabricated, always the verified token's own `sub` claim. */
export interface Actor {
  id: string | null;
  type: 'user' | 'system';
}

export interface CreateConnectorOAuthInput {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  scope?: string;
}

export interface CreateConnectorInput {
  connectorType: ConnectorType;
  provider: string;
  /** Non-OAuth path (§1): admin-entered credentials, written to Vault immediately, never persisted here. */
  credentials?: Record<string, unknown>;
  /** OAuth path (§1, ADR-0137): tenant-supplied OAuth client registration - the client secret is itself Vault'd, identically to any other credential. */
  oauth?: CreateConnectorOAuthInput;
  /**
   * §2.1: `config` also holds non-credential operational settings ("field
   * mapping refs, sync schedule"). Phase 3's `WorkdayAdapter` needs a
   * provider-facing API base URL - this is the generic extension point for
   * that and any future adapter's own non-secret settings, merged into
   * `config` after credential extraction and still run through
   * `assertNoRawCredentialMaterial` (a caller cannot use this field to
   * smuggle a raw credential past the guard).
   */
  additionalConfig?: Record<string, unknown>;
  /** Same validated `config.settings` shape `updateSettings` accepts (WFM/Timezone/Scorecards/Recorder/etc.) - lets a tenant admin configure everything in one create step instead of a required follow-up edit. Validated the same way, same non-credential guarantee. */
  settings?: Record<string, unknown>;
}

export interface CreateConnectorResult {
  connector: IntegrationConnector;
  /** Set only for the OAuth path - the URL the caller must redirect the tenant admin to. Null for the non-OAuth path (nothing further to authorize). */
  authorizationUrl: string | null;
}

/**
 * §1/§2.2 rule 1/ADR-0134/ADR-0137: the two credential-intake paths converge
 * on one storage discipline. Both branches below write credential material
 * to Vault *before* the connector row is ever persisted, and both run
 * `assertNoRawCredentialMaterial` against the exact `config` object about to
 * be written - not against the raw input, which legitimately contains the
 * credential this method is in the middle of extracting.
 */
@Injectable()
export class IntegrationConnectorsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly vault: VaultClientService,
    private readonly oauthTokenExchange: OAuthTokenExchangeService,
    private readonly audit: AuditGrpcClientService,
  ) {}

  // `actor` defaults to a system actor (rather than being required) so
  // every pre-existing internal/test caller of this method - none of
  // which know about audit attribution - keeps compiling unchanged; the
  // real GraphQL resolver always passes the verified token's own actor.
  async create(
    tenantId: string,
    rawInput: CreateConnectorInput,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<CreateConnectorResult> {
    // Defense in depth at the service boundary: `oauth` counts as
    // "provided" only if `clientId` (a genuinely required field) is
    // present - the GraphQL resolver (own doc comment) already guarantees
    // this by construction (individual scalar `@Args()`, not a composed
    // `@InputType()`), but this service has its own `CreateConnectorInput`
    // contract independent of GraphQL, and a future caller (a REST
    // endpoint, a test) could still hand it an incomplete object.
    const input: CreateConnectorInput = {
      ...rawInput,
      oauth: rawInput.oauth?.clientId ? rawInput.oauth : undefined,
    };

    if (!input.credentials && !input.oauth) {
      throw new InvalidCreateConnectorInputError('Exactly one of "credentials" or "oauth" must be provided.');
    }
    if (input.credentials && input.oauth) {
      throw new InvalidCreateConnectorInputError('Exactly one of "credentials" or "oauth" must be provided, not both.');
    }
    if (input.oauth) {
      const missing = (['clientSecret', 'authorizationEndpoint', 'tokenEndpoint', 'redirectUri'] as const).filter(
        (field) => !input.oauth![field],
      );
      if (missing.length > 0) {
        throw new InvalidCreateConnectorInputError(`OAuth input is missing required field(s): ${missing.join(', ')}.`);
      }
    }

    const connectorId = randomUUID();
    const {
      config: baseConfig,
      status,
      authorizationUrl,
    } = input.oauth
      ? await this.prepareOAuthConnector(tenantId, connectorId, input.oauth)
      : await this.prepareDirectCredentialConnector(tenantId, connectorId, input.credentials!);
    const settings = input.settings ? validateConnectorSettings(input.settings) : undefined;
    const config = { ...baseConfig, ...(input.additionalConfig ?? {}), ...(settings ? { settings } : {}) };

    assertNoRawCredentialMaterial(config);

    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IntegrationConnector, {
        id: connectorId,
        tenantId,
        connectorType: input.connectorType,
        provider: input.provider,
        status,
        config,
        lastSyncAt: null,
        lastSyncStatus: null,
      }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'connector.created',
      resourceType: 'integration_connector',
      resourceId: connector.id,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ connectorType: connector.connectorType, provider: connector.provider, status: connector.status }),
      aiRationaleJson: '',
    });

    return { connector, authorizationUrl };
  }

  async findAllForTenant(tenantId: string): Promise<IntegrationConnector[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(IntegrationConnector).find({ where: { tenantId }, order: { id: 'ASC' } }),
    );
  }

  async findByIdForTenant(tenantId: string, connectorId: string): Promise<IntegrationConnector> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: connectorId } }),
    );
    if (!connector) {
      throw new ConnectorNotFoundError(connectorId);
    }
    return connector;
  }

  /**
   * WP1: settings are validated (`validateConnectorSettings`) and merged
   * under `config.settings`, never replacing `config` wholesale - the rest
   * of `config` holds credential references/OAuth metadata this method
   * must never touch. Re-runs `assertNoRawCredentialMaterial` on the full
   * merged config for the same reason `create` does: a caller cannot use
   * this path to smuggle credential-shaped material past the guard either.
   */
  async updateSettings(
    tenantId: string,
    connectorId: string,
    rawSettings: Record<string, unknown>,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<IntegrationConnector> {
    const before = await this.findByIdForTenant(tenantId, connectorId);
    const settings = validateConnectorSettings(rawSettings);
    const config = {
      ...(before.config as Record<string, unknown>),
      settings: { ...((before.config as Record<string, unknown>).settings as Record<string, unknown> | undefined), ...settings },
    };
    assertNoRawCredentialMaterial(config);

    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IntegrationConnector, { ...before, config }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'connector.settings_updated',
      resourceType: 'integration_connector',
      resourceId: connectorId,
      beforeStateJson: JSON.stringify((before.config as Record<string, unknown>).settings ?? {}),
      afterStateJson: JSON.stringify(config.settings),
      aiRationaleJson: '',
    });

    return connector;
  }

  /**
   * Soft delete (decision #1 / `ConnectorStatus.DISABLED`'s own doc
   * comment): `agno_integration_hub_app` has no DELETE grant on this
   * table, and `field_mapping`/`sync_job`/`reason_code` all carry a real FK
   * to it - a hard delete would either fail at the DB permission layer or
   * violate referential integrity once any sync/mapping history exists.
   * Idempotent: disabling an already-disabled connector is not an error.
   */
  async disable(
    tenantId: string,
    connectorId: string,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<IntegrationConnector> {
    const before = await this.findByIdForTenant(tenantId, connectorId);
    if (before.status === ConnectorStatus.DISABLED) {
      return before;
    }

    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IntegrationConnector, { ...before, status: ConnectorStatus.DISABLED }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'connector.deleted',
      resourceType: 'integration_connector',
      resourceId: connectorId,
      beforeStateJson: JSON.stringify({ status: before.status }),
      afterStateJson: JSON.stringify({ status: ConnectorStatus.DISABLED }),
      aiRationaleJson: '',
    });

    return connector;
  }

  /**
   * WP1's "Test Connection": the one universally real, non-fabricated
   * check available across every connector type today is "can this
   * connector's stored credential/OAuth token actually be read back from
   * Vault" - `sync`-triggering adapters don't expose any lighter-weight
   * ping/health-check method of their own (checked against every
   * `sync/batch/providers/*.adapter.ts` file), so this deliberately does
   * NOT claim to verify protocol-level reachability of the external
   * system. `detail` says exactly what was and wasn't checked, rather than
   * implying a full connectivity test that didn't happen.
   */
  async testConnection(tenantId: string, connectorId: string): Promise<ConnectionTestResult> {
    const connector = await this.findByIdForTenant(tenantId, connectorId);
    const config = connector.config as Record<string, unknown>;
    const reference = (config.credentialReference ?? config.oauthClientSecretReference) as string | undefined;

    if (!reference) {
      return {
        ok: false,
        checkedAt: new Date(),
        detail: 'No credential reference is stored on this connector yet (OAuth setup incomplete).',
      };
    }

    try {
      await this.vault.read(reference);
      return {
        ok: true,
        checkedAt: new Date(),
        detail: 'Stored credential is present and readable in Vault. This does not verify reachability of the external provider.',
      };
    } catch (err) {
      if (err instanceof VaultSecretNotFoundError) {
        return { ok: false, checkedAt: new Date(), detail: 'Stored credential reference no longer exists in Vault.' };
      }
      if (err instanceof VaultUnavailableError) {
        return { ok: false, checkedAt: new Date(), detail: `Vault is unavailable: ${err.message}` };
      }
      throw err;
    }
  }

  /**
   * §3.2's `POST /v1/integrations/oauth/callback`, called by Agno's own
   * frontend after it intercepts the provider's redirect (an authenticated
   * call carrying `tenantId`'s real header/JWT) - the provider's own
   * redirect carries no tenant context, so `connectorId` is recovered from
   * `state` itself (ADR-0137), not accepted as a separate argument.
   * `tenantId` is cross-checked against `state`'s embedded tenant as
   * defense in depth: a `state` stolen from a different tenant's session
   * fails this check before ever reaching the equality comparison against
   * the connector's own stored value.
   */
  async completeOAuthCallback(tenantId: string, code: string, state: string): Promise<IntegrationConnector> {
    const parsedState = parseOAuthState(state);
    if (!parsedState || parsedState.tenantId !== tenantId) {
      throw new OAuthStateMismatchError();
    }
    const connectorId = parsedState.connectorId;

    const connector = await this.findByIdForTenant(tenantId, connectorId);
    const config = connector.config as Record<string, unknown>;

    if (connector.status !== ConnectorStatus.PENDING_SETUP || typeof config.oauthState !== 'string') {
      throw new ConnectorNotPendingOAuthSetupError(connectorId);
    }
    if (config.oauthState !== state) {
      throw new OAuthStateMismatchError();
    }

    const { clientSecret } = await this.vault.read(config.oauthClientSecretReference as string);
    const tokens = await this.oauthTokenExchange.exchangeAuthorizationCode(
      config.oauthTokenEndpoint as string,
      config.oauthClientId as string,
      clientSecret as string,
      code,
      config.oauthRedirectUri as string,
    );

    const credentialReference = this.credentialVaultPath(tenantId, connectorId);
    await this.vault.write(credentialReference, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
      tokenType: tokens.tokenType,
    });

    // `oauthState` is one-time-use and consumed here; the client secret
    // reference is deliberately kept (a future token refresh needs it
    // again), unlike `oauthState`.
    const configWithoutState = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'oauthState'));
    const newConfig = { ...configWithoutState, credentialReference };
    assertNoRawCredentialMaterial(newConfig);

    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IntegrationConnector, {
        ...connector,
        status: ConnectorStatus.ACTIVE,
        config: newConfig,
      }),
    );
  }

  private async prepareDirectCredentialConnector(
    tenantId: string,
    connectorId: string,
    credentials: Record<string, unknown>,
  ): Promise<{ config: Record<string, unknown>; status: ConnectorStatus; authorizationUrl: null }> {
    const credentialReference = this.credentialVaultPath(tenantId, connectorId);
    await this.vault.write(credentialReference, credentials);
    return {
      config: { credentialReference },
      // §1's non-OAuth path: "admin enters credentials once... Module 12
      // stores them in Vault immediately" - nothing further is needed
      // before this connector can be used, unlike the OAuth path's pending
      // redirect/callback round trip.
      status: ConnectorStatus.ACTIVE,
      authorizationUrl: null,
    };
  }

  private async prepareOAuthConnector(
    tenantId: string,
    connectorId: string,
    oauth: CreateConnectorOAuthInput,
  ): Promise<{ config: Record<string, unknown>; status: ConnectorStatus; authorizationUrl: string }> {
    const oauthClientSecretReference = this.oauthClientSecretVaultPath(tenantId, connectorId);
    await this.vault.write(oauthClientSecretReference, { clientSecret: oauth.clientSecret });

    const oauthState = generateOAuthState(tenantId, connectorId);
    const config = {
      oauthClientId: oauth.clientId,
      oauthAuthorizationEndpoint: oauth.authorizationEndpoint,
      oauthTokenEndpoint: oauth.tokenEndpoint,
      oauthRedirectUri: oauth.redirectUri,
      oauthScope: oauth.scope ?? null,
      oauthClientSecretReference,
      oauthState,
    };
    return {
      config,
      status: ConnectorStatus.PENDING_SETUP,
      authorizationUrl: this.buildAuthorizationUrl(oauth, oauthState),
    };
  }

  private buildAuthorizationUrl(oauth: CreateConnectorOAuthInput, state: string): string {
    const url = new URL(oauth.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', oauth.clientId);
    url.searchParams.set('redirect_uri', oauth.redirectUri);
    url.searchParams.set('state', state);
    if (oauth.scope) {
      url.searchParams.set('scope', oauth.scope);
    }
    return url.toString();
  }

  private credentialVaultPath(tenantId: string, connectorId: string): string {
    return `integration-hub/${tenantId}/${connectorId}/credential`;
  }

  private oauthClientSecretVaultPath(tenantId: string, connectorId: string): string {
    return `integration-hub/${tenantId}/${connectorId}/oauth-client-secret`;
  }
}
