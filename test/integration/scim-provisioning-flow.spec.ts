import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { UsersRepository } from '../../src/modules/identity/repositories/users.repository';
import { RolesRepository } from '../../src/modules/identity/repositories/roles.repository';
import { UserRolesRepository } from '../../src/modules/identity/repositories/user-roles.repository';
import { RefreshTokensRepository } from '../../src/modules/auth/repositories/refresh-tokens.repository';
import { RefreshTokenService } from '../../src/modules/auth/services/refresh-token.service';
import { OAuthClientsRepository } from '../../src/modules/auth/repositories/oauth-clients.repository';
import { OAuthClientType } from '../../src/modules/auth/entities/oauth-client-type.enum';
import { OAuthGrantType } from '../../src/modules/auth/entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../../src/modules/auth/entities/token-endpoint-auth-method.enum';
import { ScimUsersService } from '../../src/modules/scim/services/scim-users.service';
import { ScimGroupsService } from '../../src/modules/scim/services/scim-groups.service';
import { RefreshTokenReusedError } from '../../src/modules/auth/errors/refresh-token-reused.error';

dotenv.config();

/**
 * Phase 3's SCIM 2.0 provisioning (§5.3), exercised at the service layer
 * against real Postgres + Redis - the layer `ScimUsersController`/
 * `ScimGroupsController` call into. Covers §5.7's explicit requirement: "a
 * SCIM deprovisioning request for a user mid-session must force session
 * revocation."
 */
describe('Phase 3 - SCIM 2.0 provisioning (service layer, real Postgres + Redis)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let redisClient: Redis;
  let tenantContext: TenantContextService;

  let usersRepository: UsersRepository;
  let rolesRepository: RolesRepository;
  let userRolesRepository: UserRolesRepository;
  let refreshTokenService: RefreshTokenService;
  let scimUsers: ScimUsersService;
  let scimGroups: ScimGroupsService;

  let tenantId: string;
  let clientId: string;

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

    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
    const redisService = new RedisService(redisClient);

    tenantContext = new TenantContextService();
    usersRepository = new UsersRepository(appDataSource, tenantContext);
    rolesRepository = new RolesRepository(appDataSource, tenantContext);
    userRolesRepository = new UserRolesRepository(appDataSource, tenantContext);
    const refreshTokensRepository = new RefreshTokensRepository(appDataSource, tenantContext);
    refreshTokenService = new RefreshTokenService(refreshTokensRepository, redisService, tenantContext);
    scimUsers = new ScimUsersService(usersRepository, refreshTokenService);
    scimGroups = new ScimGroupsService(rolesRepository, userRolesRepository, usersRepository);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `SCIM Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    // refresh_tokens.client_id has a real FK to oauth_clients(id) - a fixture row is required, not just any uuid.
    const oauthClientsRepository = new OAuthClientsRepository(appDataSource, tenantContext);
    const client = await tenantContext.run({ tenantId }, () =>
      oauthClientsRepository.create({
        tenantId,
        clientId: `scim-test-client-${uuidv4()}`,
        clientSecretHash: null,
        clientType: OAuthClientType.PUBLIC,
        name: 'SCIM Test Client',
        allowedGrantTypes: [OAuthGrantType.AUTHORIZATION_CODE, OAuthGrantType.REFRESH_TOKEN],
        redirectUris: ['http://localhost/callback'],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.NONE,
        isActive: true,
      }),
    );
    clientId = client.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
    redisClient.disconnect();
  });

  it('creates a SCIM-provisioned user with no local password credential', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const user = await scimUsers.create(tenantId, {
        userName: `scim-user-${uuidv4()}@example.com`,
        externalId: 'idp-subject-1',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
      });
      expect(user.status).toBe(UserStatus.ACTIVE);
      expect(user.givenName).toBe('Ada');
      expect(user.externalIdpId).toBe('idp-subject-1');
    });
  });

  it('§5.7: deactivating a user via SCIM PATCH forces revocation of their active sessions', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const user = await scimUsers.create(tenantId, { userName: `scim-deprovision-${uuidv4()}@example.com` });

      const { rawToken } = await refreshTokenService.issue({
        tenantId,
        userId: user.id,
        clientId,
        amr: ['pwd'],
        authTime: new Date(),
        scope: '',
      });

      // Session is valid before deprovisioning.
      const rotated = await refreshTokenService.rotate(rawToken);
      expect(rotated.rawToken).toBeTruthy();

      await scimUsers.applyPatch(user.id, [{ op: 'replace', path: 'active', value: false }]);

      const reloaded = await scimUsers.getOrFail(user.id);
      expect(reloaded.status).toBe(UserStatus.DISABLED);

      // The session that was still valid a moment ago must now be rejected.
      await expect(refreshTokenService.rotate(rotated.rawToken)).rejects.toThrow(RefreshTokenReusedError);
    });
  });

  it('SCIM Groups: create with members, then add/remove via PATCH', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const userA = await scimUsers.create(tenantId, { userName: `group-member-a-${uuidv4()}@example.com` });
      const userB = await scimUsers.create(tenantId, { userName: `group-member-b-${uuidv4()}@example.com` });

      const created = await scimGroups.create({
        displayName: `SCIM Test Group ${uuidv4()}`,
        members: [{ value: userA.id }],
      });
      expect(created.members.map((m) => m.id)).toEqual([userA.id]);

      const afterAdd = await scimGroups.applyPatch(created.role.id, [
        { op: 'add', path: 'members', value: [{ value: userB.id }] },
      ]);
      expect(afterAdd.members.map((m) => m.id).sort()).toEqual([userA.id, userB.id].sort());

      const afterRemove = await scimGroups.applyPatch(created.role.id, [
        { op: 'remove', path: 'members', value: [{ value: userA.id }] },
      ]);
      expect(afterRemove.members.map((m) => m.id)).toEqual([userB.id]);

      await scimGroups.delete(created.role.id);
      await expect(scimGroups.getOrFail(created.role.id)).rejects.toThrow();
    });
  });
});
