import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { X509Certificate } from 'node:crypto';
import { TenantIdentityProviderService } from '../services/tenant-identity-provider.service';
import { OidcFederationService } from '../services/oidc-federation.service';
import { CreateIdentityProviderDto } from '../dto/create-identity-provider.dto';
import { UpdateIdentityProviderDto } from '../dto/update-identity-provider.dto';
import { TenantIdentityProviderView, toIdentityProviderView } from './tenant-identity-provider.view';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { IdentityProviderProtocol } from '../entities/identity-provider-protocol.enum';

/**
 * Admin CRUD over §5.5's per-tenant IdP config - not named in §3.2's literal
 * endpoint table (only `POST /v1/auth/sso/callback` is), but required by
 * §5.5's own instruction to "design [`TenantIdentityProvider`] as part of
 * this phase and connect it to the /v1/auth/sso/callback dispatch logic":
 * without a way to create rows in this table, that connection is untestable.
 *
 * Phase 4 update: gated by real RBAC (`tenant:read`/`tenant:write` - IdP
 * config is tenant administration, reusing the existing `tenant` resource
 * rather than inventing a new one) - the readiness-checklist TODO Phase 3
 * explicitly left for "real admin-permission gating" (ADR-0026). Every
 * other `/v1/*` endpoint elsewhere in this repo predating Phase 4's RBAC
 * enforcement is deliberately left as-is here - retrofitting the rest is a
 * separate, deliberate piece of work, not a side effect of this phase.
 *
 * Follow-up to Phase 5 (ADR-0044): every mutation records a synchronous
 * `AuditLogRepository` entry, the same admin-CRUD pattern
 * `RoleManagementController`/`PolicyManagementController` already use - IdP
 * config changes are exactly the kind of low-volume, high-consequence
 * action this platform's audit trail exists for.
 */
@Controller('v1/identity-providers')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TenantIdentityProvidersController {
  constructor(
    private readonly service: TenantIdentityProviderService,
    private readonly oidcFederation: OidcFederationService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('tenant:read')
  async list(): Promise<TenantIdentityProviderView[]> {
    return (await this.service.list()).map(toIdentityProviderView);
  }

  @Get(':id')
  @RequirePermissions('tenant:read')
  async get(@Param('id') id: string): Promise<TenantIdentityProviderView> {
    return toIdentityProviderView(await this.service.getOrFail(id));
  }

  /**
   * Frontend Phase 8 gap-fix (§2, §0.5's progressive-delivery row): the
   * "test connection" step before a tenant marks this provider active - a
   * real validation round-trip, never a client-side approximation. OIDC:
   * `OidcFederationService.testDiscovery` (a real `Issuer.discover(...)`
   * fetch against the stored `oidcDiscoveryUrl`). SAML: this platform has
   * no metadata-URL model for SAML (`samlEntityId`/`samlSsoUrl`/`samlCertificate`
   * are admin-entered directly, not fetched from anywhere) - the one
   * concrete, real thing to validate is that the stored certificate is a
   * well-formed X.509 cert, since a malformed one breaks every future login
   * attempt through this provider; `node:crypto`'s own `X509Certificate`
   * constructor throws on a malformed PEM, no third-party parser needed.
   * `POST`, not `GET` - it makes a real outbound network call to an
   * external IdP on every invocation, same "an action, not a cacheable
   * read" reasoning `testWebhook` (Module 12) already applied. Still
   * gated `tenant:read`, not `:write` - it performs no persistence of its
   * own, so the least-privilege permission is the read one.
   */
  @Post(':id/test-connection')
  @RequirePermissions('tenant:read')
  async testConnection(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    const provider = await this.service.getOrFail(id);
    if (provider.protocol === IdentityProviderProtocol.OIDC) {
      return this.oidcFederation.testDiscovery(provider);
    }
    try {
      const cert = new X509Certificate(provider.samlCertificate!);
      return { success: true, message: `SAML certificate is well-formed (subject: ${cert.subject}).` };
    } catch (err) {
      return { success: false, message: `SAML certificate is invalid: ${(err as Error).message}` };
    }
  }

  @Post()
  @RequirePermissions('tenant:write')
  async create(
    @Req() req: RequestWithTokenClaims,
    @Body() input: CreateIdentityProviderDto,
  ): Promise<TenantIdentityProviderView> {
    const created = await this.service.create(input);
    await this.audit(req, 'tenant_identity_provider.created', created.id, null, {
      protocol: created.protocol,
      name: created.name,
    });
    return toIdentityProviderView(created);
  }

  @Put(':id')
  @RequirePermissions('tenant:write')
  async update(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() input: UpdateIdentityProviderDto,
  ): Promise<TenantIdentityProviderView> {
    const before = await this.service.getOrFail(id);
    const updated = await this.service.update(id, input);
    await this.audit(
      req,
      'tenant_identity_provider.updated',
      id,
      { name: before.name, isActive: before.isActive },
      { name: updated.name, isActive: updated.isActive },
    );
    return toIdentityProviderView(updated);
  }

  @Delete(':id')
  @RequirePermissions('tenant:write')
  async remove(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ deleted: true }> {
    const before = await this.service.getOrFail(id);
    await this.service.delete(id);
    await this.audit(req, 'tenant_identity_provider.deleted', id, { name: before.name }, null);
    return { deleted: true };
  }

  private async audit(
    req: RequestWithTokenClaims,
    action: string,
    resourceId: string,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): Promise<void> {
    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'tenant_identity_provider',
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
