import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { OAuthClientsRepository } from '../../auth/repositories/oauth-clients.repository';
import { PasswordHasherService } from '../../auth/services/password-hasher.service';
import { OAuthClientType } from '../../auth/entities/oauth-client-type.enum';
import { OAuthGrantType } from '../../auth/entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../../auth/entities/token-endpoint-auth-method.enum';
import { OAuthClient } from '../../auth/entities/oauth-client.entity';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

const SCIM_CLIENT_NAME = 'SCIM Provisioning';

export interface ScimCredentialView {
  id: string;
  clientId: string;
  createdAt: Date;
  isActive: boolean;
}

/**
 * Tenant-scoped self-service alternative to `POST /oauth/register` for the
 * one integration a tenant admin actually needs to self-serve: a
 * `client_credentials` OAuth client for driving `/scim/v2/*`. `/oauth/register`
 * itself stays as-is (gated by the platform's static bootstrap token, for
 * out-of-band/ops registration - see OAuthController.register's doc
 * comment) since a browser-held admin session should never hold that
 * platform-wide secret. This endpoint reuses the same
 * `OAuthClientsRepository`/`PasswordHasherService` client-creation path,
 * just gated by the caller's own `tenant:write` permission instead - the
 * same RBAC convention `TenantIdentityProvidersController` uses for IdP
 * config, since this is likewise tenant administration rather than a new
 * resource.
 *
 * `oauth_clients` has no dedicated `purpose`/`scope` column (ADR-0028), so
 * `name` is used as the marker distinguishing SCIM-purpose clients from any
 * other OAuth client registered for the tenant. Note this only identifies
 * *which* clients this endpoint manages - it does not, on its own, restrict
 * what a SCIM client's token can call: `ScimAuthGuard` currently accepts any
 * valid client_credentials token for the tenant, not just ones created here
 * (see that guard's own doc comment).
 */
@Controller('v1/scim/credentials')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class ScimCredentialsController {
  constructor(
    private readonly oauthClients: OAuthClientsRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('tenant:read')
  async list(): Promise<ScimCredentialView[]> {
    const clients = await this.oauthClients.findAllForTenant();
    return clients.filter((client) => client.name === SCIM_CLIENT_NAME).map(toView);
  }

  @Post()
  @RequirePermissions('tenant:write')
  async create(@Req() req: RequestWithTokenClaims): Promise<ScimCredentialView & { clientSecret: string }> {
    const claims = req.tokenClaims!;
    const clientId = randomUUID();
    const plaintextSecret = randomBytes(24).toString('base64url');
    const clientSecretHash = await this.passwordHasher.hash(plaintextSecret);

    const created = await this.oauthClients.create({
      tenantId: claims.tenant_id,
      clientId,
      clientSecretHash,
      clientType: OAuthClientType.CONFIDENTIAL,
      name: SCIM_CLIENT_NAME,
      allowedGrantTypes: [OAuthGrantType.CLIENT_CREDENTIALS],
      redirectUris: [],
      tokenEndpointAuthMethod: TokenEndpointAuthMethod.CLIENT_SECRET_BASIC,
      isActive: true,
    });

    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'scim_credential.created',
      resourceType: 'oauth_client',
      resourceId: created.id,
      beforeState: null,
      afterState: { clientId: created.clientId, name: created.name },
      aiRationale: null,
    });

    return { ...toView(created), clientSecret: plaintextSecret };
  }

  @Delete(':id')
  @RequirePermissions('tenant:write')
  async revoke(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ revoked: true }> {
    const claims = req.tokenClaims!;
    const existing = await this.oauthClients.findByTenantAndId(id);
    if (!existing || existing.name !== SCIM_CLIENT_NAME) {
      throw new NotFoundException('SCIM credential not found.');
    }

    await this.oauthClients.deactivate(id);
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'scim_credential.revoked',
      resourceType: 'oauth_client',
      resourceId: id,
      beforeState: { isActive: true },
      afterState: { isActive: false },
      aiRationale: null,
    });
    return { revoked: true };
  }
}

function toView(client: OAuthClient): ScimCredentialView {
  return { id: client.id, clientId: client.clientId, createdAt: client.createdAt, isActive: client.isActive };
}
