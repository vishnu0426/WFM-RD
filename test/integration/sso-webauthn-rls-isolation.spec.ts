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
import { TenantIdentityProvidersRepository } from '../../src/modules/sso/repositories/tenant-identity-providers.repository';
import { WebAuthnCredentialsRepository } from '../../src/modules/webauthn/repositories/webauthn-credentials.repository';
import { IdentityProviderProtocol } from '../../src/modules/sso/entities/identity-provider-protocol.enum';
import { WebAuthnDeviceType } from '../../src/modules/webauthn/entities/webauthn-device-type.enum';

dotenv.config();

/**
 * Phase 3's RLS additions (§2.2 rule 1, ADR-0029): `tenant_identity_providers`
 * (read-open/write-gated, mirroring ADR-0028) and `webauthn_credentials`
 * (standard closed tenant isolation, like `user_credentials`).
 */
describe('Phase 3 tenant isolation (tenant_identity_providers, webauthn_credentials)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let identityProviders: TenantIdentityProvidersRepository;
  let webauthnCredentials: WebAuthnCredentialsRepository;

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
    identityProviders = new TenantIdentityProvidersRepository(appDataSource, tenantContext);
    webauthnCredentials = new WebAuthnCredentialsRepository(appDataSource, tenantContext);

    const tenantRepo = migratorDataSource.getRepository(Tenant);
    const tenantA = await tenantRepo.save(
      tenantRepo.create({
        name: `SSO RLS Test Tenant A ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    const tenantB = await tenantRepo.save(
      tenantRepo.create({
        name: `SSO RLS Test Tenant B ${uuidv4()}`,
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
        email: `sso-rls-a-${uuidv4()}@example.com`,
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

  it('tenant_identity_providers: ADR-0029 - SELECT is open across tenants, INSERT is tenant-gated', async () => {
    const created = await tenantContext.run({ tenantId: tenantAId }, () =>
      identityProviders.create({
        tenantId: tenantAId,
        protocol: IdentityProviderProtocol.OIDC,
        name: `RLS Test IdP ${uuidv4()}`,
        isActive: true,
        oidcDiscoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
        oidcClientId: 'client-id',
        oidcClientSecret: 'client-secret',
        samlEntityId: null,
        samlSsoUrl: null,
        samlSloUrl: null,
        samlCertificate: null,
        attributeMapping: {},
      }),
    );

    const foundFromB = await tenantContext.run({ tenantId: tenantBId }, () => identityProviders.findById(created.id));
    expect(foundFromB?.tenantId).toBe(tenantAId);

    const foundUnscoped = await identityProviders.findById(created.id);
    expect(foundUnscoped?.id).toBe(created.id);

    // Tenant B cannot see it through the tenant-scoped listing.
    const listedByB = await tenantContext.run({ tenantId: tenantBId }, () => identityProviders.findAllForTenant());
    expect(listedByB.map((p) => p.id)).not.toContain(created.id);
  });

  it('tenant_identity_providers: raw INSERT claiming another tenant is rejected by RLS', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await rawClient.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantAId]);
      await expect(
        rawClient.query(
          `INSERT INTO core.tenant_identity_providers
             (tenant_id, protocol, name, saml_entity_id, saml_sso_url, saml_certificate)
           VALUES ($1, 'saml', 'cross-tenant-attempt', 'entity', 'https://idp/sso', 'cert')`,
          [tenantBId],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await rawClient.end();
    }
  });

  it('the application guard fails closed with no tenant context bound (webauthn_credentials)', async () => {
    await expect(webauthnCredentials.find()).rejects.toThrow(TenantContextMissingError);
  });

  it("webauthn_credentials: a tenant's repository view only returns that tenant's rows", async () => {
    await tenantContext.run({ tenantId: tenantAId }, () =>
      webauthnCredentials.save({
        tenantId: tenantAId,
        userId: userAId,
        credentialId: `cred-${uuidv4()}`,
        publicKey: Buffer.from('fake-public-key').toString('base64'),
        counter: 0,
        deviceType: WebAuthnDeviceType.SINGLE_DEVICE,
        backedUp: false,
        transports: ['internal'],
        deviceName: 'Test Device',
        lastUsedAt: null,
      } as never),
    );

    const seenByA = await tenantContext.run({ tenantId: tenantAId }, () => webauthnCredentials.findForUser(userAId));
    expect(seenByA.length).toBeGreaterThan(0);

    const seenByB = await tenantContext.run({ tenantId: tenantBId }, () => webauthnCredentials.findForUser(userAId));
    expect(seenByB).toHaveLength(0);
  });

  it('webauthn_credentials: raw Postgres RLS returns zero rows with no session tenant bound', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM core.webauthn_credentials WHERE user_id = $1', [userAId]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });
});
