import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant, User } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantContextMissingError } from '../../src/common/tenant/tenant-context.errors';
import { OAuthClientsRepository } from '../../src/modules/auth/repositories/oauth-clients.repository';
import { UserCredentialsRepository } from '../../src/modules/auth/repositories/user-credentials.repository';
import { SigningKeysRepository } from '../../src/modules/auth/repositories/signing-keys.repository';
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { OAuthClientType } from '../../src/modules/auth/entities/oauth-client-type.enum';
import { OAuthGrantType } from '../../src/modules/auth/entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../../src/modules/auth/entities/token-endpoint-auth-method.enum';
import { SigningKeyStatus } from '../../src/modules/auth/entities/signing-key-status.enum';

dotenv.config();

/**
 * Phase 2's RLS additions (§2.2 rule 1 + ADR-0028), same two-layer-defense
 * proof style as test/integration/rls-isolation.spec.ts: the application
 * guard (`TenantScopedRepository`) AND raw Postgres RLS underneath it,
 * talking to the DB directly as `agno_app` with no bound tenant context.
 */
describe('Phase 2 tenant isolation (oauth_clients, user_credentials, refresh_tokens, signing_keys)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let oauthClientsRepository: OAuthClientsRepository;
  let userCredentialsRepository: UserCredentialsRepository;
  let signingKeysRepository: SigningKeysRepository;

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();

    tenantContext = new TenantContextService();
    oauthClientsRepository = new OAuthClientsRepository(appDataSource, tenantContext);
    userCredentialsRepository = new UserCredentialsRepository(appDataSource, tenantContext);
    signingKeysRepository = new SigningKeysRepository(appDataSource);
    // Idempotent - only bootstraps a key if none is active yet. Test files
    // in this suite don't share a guaranteed run order, so this can't
    // assume another file's beforeAll already did this (see ADR-0024).
    await new SigningKeyService(signingKeysRepository).onModuleInit();

    const tenantRepo = migratorDataSource.getRepository(Tenant);
    const tenantA = await tenantRepo.save(
      tenantRepo.create({
        name: `Auth RLS Test Tenant A ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    const tenantB = await tenantRepo.save(
      tenantRepo.create({
        name: `Auth RLS Test Tenant B ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantAId]);
    const userA = await migratorDataSource.getRepository(User).save(
      migratorDataSource.getRepository(User).create({
        tenantId: tenantAId,
        email: `auth-rls-a-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    userAId = userA.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('the application guard fails closed with no tenant context bound (user_credentials)', async () => {
    await expect(userCredentialsRepository.find()).rejects.toThrow(TenantContextMissingError);
  });

  it("user_credentials: a tenant's repository view only returns that tenant's rows", async () => {
    await tenantContext.run({ tenantId: tenantAId }, () =>
      userCredentialsRepository.save({
        userId: userAId,
        tenantId: tenantAId,
        passwordHash: 'irrelevant-hash',
        passwordAlgorithm: 'bcrypt',
        passwordUpdatedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never),
    );

    const seenByA = await tenantContext.run({ tenantId: tenantAId }, () => userCredentialsRepository.find());
    expect(seenByA.map((c) => c.userId)).toContain(userAId);

    const seenByB = await tenantContext.run({ tenantId: tenantBId }, () => userCredentialsRepository.find());
    expect(seenByB.map((c) => c.userId)).not.toContain(userAId);
  });

  it('user_credentials: raw Postgres RLS returns zero rows with no session tenant bound', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT user_id FROM core.user_credentials WHERE user_id = $1', [userAId]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('oauth_clients: ADR-0028 - SELECT is open across tenants (client_id lookup happens before tenant is known)', async () => {
    const clientId = `rls-test-client-${uuidv4()}`;
    await tenantContext.run({ tenantId: tenantAId }, () =>
      oauthClientsRepository.create({
        tenantId: tenantAId,
        clientId,
        clientSecretHash: null,
        clientType: OAuthClientType.PUBLIC,
        name: 'RLS Test Client',
        allowedGrantTypes: [OAuthGrantType.AUTHORIZATION_CODE],
        redirectUris: ['http://localhost/callback'],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.NONE,
        isActive: true,
      }),
    );

    // Found via a bound-B context (proves read-open), and via no bound
    // context at all (findByClientId never binds one - see its own doc comment).
    const foundFromB = await tenantContext.run({ tenantId: tenantBId }, () =>
      oauthClientsRepository.findByClientId(clientId),
    );
    expect(foundFromB?.tenantId).toBe(tenantAId);

    const foundUnscoped = await oauthClientsRepository.findByClientId(clientId);
    expect(foundUnscoped?.clientId).toBe(clientId);
  });

  it('oauth_clients: ADR-0028 - INSERT is still tenant-gated despite open SELECT', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      // Session bound to tenant A, attempting to INSERT a row claiming tenant B.
      await rawClient.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantAId]);
      await expect(
        rawClient.query(
          `INSERT INTO core.oauth_clients
             (tenant_id, client_id, client_type, name, allowed_grant_types, redirect_uris, token_endpoint_auth_method)
           VALUES ($1, $2, 'public', 'cross-tenant-insert-attempt', ARRAY['authorization_code'], ARRAY[]::text[], 'none')`,
          [tenantBId, `cross-tenant-${uuidv4()}`],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await rawClient.end();
    }
  });

  it('signing_keys: global reference data, no RLS - readable without any tenant context (ADR-0024)', async () => {
    const active = await signingKeysRepository.findActive();
    expect(active?.status).toBe(SigningKeyStatus.ACTIVE);
    expect(active?.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});
