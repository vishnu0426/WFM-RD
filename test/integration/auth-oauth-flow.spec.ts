import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { entities, Tenant, User } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { UsersRepository } from '../../src/modules/identity/repositories/users.repository';
import { UserContextResolverService } from '../../src/modules/identity/services/user-context-resolver.service';
import { OAuthClientsRepository } from '../../src/modules/auth/repositories/oauth-clients.repository';
import { UserCredentialsRepository } from '../../src/modules/auth/repositories/user-credentials.repository';
import { SigningKeysRepository } from '../../src/modules/auth/repositories/signing-keys.repository';
import { AuthorizationCodesRepository } from '../../src/modules/auth/repositories/authorization-codes.repository';
import { RefreshTokensRepository } from '../../src/modules/auth/repositories/refresh-tokens.repository';
import { TenantSettingsRepository } from '../../src/modules/tenant-settings/repositories/tenant-settings.repository';
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { PkceService } from '../../src/modules/auth/services/pkce.service';
import { TokenService } from '../../src/modules/auth/services/token.service';
import { RefreshTokenService } from '../../src/modules/auth/services/refresh-token.service';
import { AuthorizationCodeService } from '../../src/modules/auth/services/authorization-code.service';
import { OAuthClientAuthService } from '../../src/modules/auth/services/oauth-client-auth.service';
import { PasswordAuthService } from '../../src/modules/auth/services/password-auth.service';
import { PasswordHasherService } from '../../src/modules/auth/services/password-hasher.service';
import { UserContextCacheService } from '../../src/modules/auth/services/user-context-cache.service';
import { OAuthClientType } from '../../src/modules/auth/entities/oauth-client-type.enum';
import { OAuthGrantType } from '../../src/modules/auth/entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../../src/modules/auth/entities/token-endpoint-auth-method.enum';
import { InvalidGrantError } from '../../src/modules/auth/errors/invalid-grant.error';
import { RefreshTokenReusedError } from '../../src/modules/auth/errors/refresh-token-reused.error';

dotenv.config();

/**
 * Phase 2 (§8), exercised end to end against a real Postgres + Redis at the
 * service/repository layer - the same layer `OAuthController` calls into,
 * without going through HTTP/DTO validation (that wiring is covered by
 * TypeScript's own structural checks on the controller; this suite proves
 * the business logic underneath it: PKCE, single-use codes, JWT issuance/
 * verification against the bootstrapped signing key, and ADR-0025's
 * rotation + reuse-detection).
 */
describe('Phase 2 - OAuth2.1/OIDC identity core (service layer, real Postgres + Redis)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let redisClient: Redis;
  let tenantContext: TenantContextService;
  let redisService: RedisService;

  let oauthClientsRepository: OAuthClientsRepository;
  let userCredentialsRepository: UserCredentialsRepository;
  let signingKeysRepository: SigningKeysRepository;
  let authorizationCodesRepository: AuthorizationCodesRepository;
  let refreshTokensRepository: RefreshTokensRepository;
  let usersRepository: UsersRepository;

  let signingKeyService: SigningKeyService;
  let pkceService: PkceService;
  let tokenService: TokenService;
  let refreshTokenService: RefreshTokenService;
  let authorizationCodeService: AuthorizationCodeService;
  let clientAuthService: OAuthClientAuthService;
  let passwordAuthService: PasswordAuthService;
  let userContextCache: UserContextCacheService;

  let tenantId: string;
  let userId: string;
  let publicClientId: string; // the OAuthClient row's own `clientId` string, not its uuid `id`
  let publicClientUuid: string;
  const redirectUri = 'http://localhost:3000/callback';
  const password = 'Correct-Horse-Battery-Staple-1!';

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
    redisService = new RedisService(redisClient);

    tenantContext = new TenantContextService();

    oauthClientsRepository = new OAuthClientsRepository(appDataSource, tenantContext);
    userCredentialsRepository = new UserCredentialsRepository(appDataSource, tenantContext);
    signingKeysRepository = new SigningKeysRepository(appDataSource);
    authorizationCodesRepository = new AuthorizationCodesRepository(appDataSource, tenantContext);
    refreshTokensRepository = new RefreshTokensRepository(appDataSource, tenantContext);
    usersRepository = new UsersRepository(appDataSource, tenantContext);

    signingKeyService = new SigningKeyService(signingKeysRepository);
    await signingKeyService.onModuleInit(); // idempotent - bootstraps a key only if none is active

    pkceService = new PkceService();
    tokenService = new TokenService(signingKeyService, {
      get: (key: string, fallback?: string) =>
        ({ OIDC_ISSUER: 'https://auth.agno-wfm.local', OIDC_AUDIENCE: 'agno-core-api' })[key] ?? fallback,
    } as never);
    refreshTokenService = new RefreshTokenService(refreshTokensRepository, redisService, tenantContext);
    authorizationCodeService = new AuthorizationCodeService(authorizationCodesRepository);
    const passwordHasher = new PasswordHasherService({ get: () => 4 } as never);
    clientAuthService = new OAuthClientAuthService(oauthClientsRepository, passwordHasher);
    const tenantSettingsRepository = new TenantSettingsRepository(appDataSource, tenantContext);
    passwordAuthService = new PasswordAuthService(
      usersRepository,
      userCredentialsRepository,
      passwordHasher,
      tenantSettingsRepository,
    );
    const userContextResolver = new UserContextResolverService(appDataSource, tenantContext);
    userContextCache = new UserContextCacheService(redisService, userContextResolver);

    // --- Fixtures: tenant, user, password credential, public PKCE client ---
    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Auth Flow Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const user = await migratorDataSource.getRepository(User).save(
      migratorDataSource.getRepository(User).create({
        tenantId,
        email: `auth-flow-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    userId = user.id;

    const passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(4));
    await tenantContext.run({ tenantId }, () =>
      userCredentialsRepository.save({
        userId,
        tenantId,
        passwordHash,
        passwordAlgorithm: 'bcrypt',
        passwordUpdatedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      } as never),
    );

    publicClientId = `test-public-client-${uuidv4()}`;
    const client = await tenantContext.run({ tenantId }, () =>
      oauthClientsRepository.create({
        tenantId,
        clientId: publicClientId,
        clientSecretHash: null,
        clientType: OAuthClientType.PUBLIC,
        name: 'Auth Flow Test Public Client',
        allowedGrantTypes: [OAuthGrantType.AUTHORIZATION_CODE, OAuthGrantType.REFRESH_TOKEN],
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.NONE,
        isActive: true,
      }),
    );
    publicClientUuid = client.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
    redisClient.disconnect();
  });

  it('OAuthClientsRepository.findByClientId resolves a client before any tenant context is bound (ADR-0028)', async () => {
    const client = await oauthClientsRepository.findByClientId(publicClientId);
    expect(client?.id).toBe(publicClientUuid);
  });

  it('full authorization_code + PKCE flow issues a valid access token and refresh token', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const client = await clientAuthService.authenticate(publicClientId, null);
      clientAuthService.assertGrantTypeAllowed(client, OAuthGrantType.AUTHORIZATION_CODE);
      clientAuthService.assertRedirectUriRegistered(client, redirectUri);

      const user = await passwordAuthService.authenticate(
        (await usersRepository.findOne({ where: { id: userId } as never }))!.email,
        password,
      );
      expect(user.id).toBe(userId);

      const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const codeChallenge = pkceService.computeChallenge(codeVerifier);
      const authTime = new Date();

      const code = await authorizationCodeService.issue({
        tenantId,
        clientId: client.id,
        userId,
        redirectUri,
        codeChallenge,
        scope: 'openid',
        nonce: 'test-nonce',
        authTime,
        amr: ['pwd'],
      });

      const record = await authorizationCodeService.consume(code, client.id, redirectUri);
      expect(record.userId).toBe(userId);
      pkceService.verify(codeVerifier, record.codeChallenge);

      // Single-use: consuming the same code again must fail.
      await expect(authorizationCodeService.consume(code, client.id, redirectUri)).rejects.toThrow(InvalidGrantError);

      const userContext = await userContextCache.get(tenantId, userId);
      const { token: accessToken, claims } = await tokenService.issueAccessToken({
        userId,
        tenantId,
        orgUnitId: userContext.orgUnitId,
        roles: userContext.roles,
        permissions: userContext.permissions,
        amr: record.amr,
        authTime: record.authTime,
      });
      expect(claims.sub).toBe(userId);
      expect(claims.tenant_id).toBe(tenantId);

      const verified = await tokenService.verifyAccessToken(accessToken);
      expect(verified.sub).toBe(userId);

      const { rawToken: refreshToken, record: refreshRecord } = await refreshTokenService.issue({
        tenantId,
        userId,
        clientId: client.id,
        amr: record.amr,
        authTime: record.authTime,
        scope: record.scope,
      });
      expect(refreshRecord.generation).toBe(1);

      // --- Rotation ---
      const rotated = await refreshTokenService.rotate(refreshToken);
      expect(rotated.record.generation).toBe(2);
      expect(rotated.record.familyId).toBe(refreshRecord.familyId);
      expect(rotated.rawToken).not.toBe(refreshToken);

      // --- Reuse detection: presenting the already-rotated (generation 1) token again ---
      await expect(refreshTokenService.rotate(refreshToken)).rejects.toThrow(RefreshTokenReusedError);

      // The whole family (including the generation-2 token issued above) must now be revoked too.
      await expect(refreshTokenService.rotate(rotated.rawToken)).rejects.toThrow(InvalidGrantError);
    });
  });

  it('JWKS exposes the active signing key with the right shape', async () => {
    const jwks = await signingKeyService.getJwks();
    expect(jwks.keys.length).toBeGreaterThan(0);
    const key = jwks.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('RS256');
    expect(key.kid).toEqual(expect.any(String));
  });

  it('a tampered access token fails verification', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const { token } = await tokenService.issueAccessToken({
        userId,
        tenantId,
        orgUnitId: null,
        roles: [],
        permissions: [],
        amr: ['pwd'],
        authTime: new Date(),
      });
      const [header] = token.split('.');
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
      await expect(tokenService.verifyAccessToken(`${header}.${tamperedPayload}.invalid-signature`)).rejects.toThrow(
        InvalidGrantError,
      );
    });
  });

  it('wrong password is rejected without revealing whether the account exists', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const user = (await usersRepository.findOne({ where: { id: userId } as never }))!;
      await expect(passwordAuthService.authenticate(user.email, 'totally-wrong-password')).rejects.toThrow();
      await expect(passwordAuthService.authenticate('nonexistent@example.com', 'irrelevant')).rejects.toThrow();
    });
  });

  it("a refresh token's Redis fast-path cache is invalidated on rotation", async () => {
    await tenantContext.run({ tenantId }, async () => {
      const { rawToken } = await refreshTokenService.issue({
        tenantId,
        userId,
        clientId: publicClientUuid,
        amr: ['pwd'],
        authTime: new Date(),
        scope: '',
      });
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const cachedBefore = await redisService.get(`session:refresh:token:${tokenHash}`);
      expect(cachedBefore).not.toBeNull();

      await refreshTokenService.rotate(rawToken);
      const cachedAfter = await redisService.get(`session:refresh:token:${tokenHash}`);
      expect(cachedAfter).toBeNull();
    });
  });
});
