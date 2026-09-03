import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { OAuthClientsRepository } from '../../auth/repositories/oauth-clients.repository';
import { InvalidClientError } from '../../auth/errors/invalid-client.error';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { WebAuthnService } from '../services/webauthn.service';
import { WebAuthnCredentialsRepository } from '../repositories/webauthn-credentials.repository';
import { RegisterVerifyDto } from '../dto/register-verify.dto';
import { AuthenticateOptionsRequestDto } from '../dto/authenticate-options-request.dto';
import { AuthenticateVerifyDto } from '../dto/authenticate-verify.dto';
import { WebAuthnChallengeExpiredError } from '../errors/webauthn-challenge-expired.error';
import { AuditEventBatcherService } from '../../audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §5.4's WebAuthn/Passkeys ceremony endpoints. Registration requires an
 * already-authenticated user (`AccessTokenGuard` - you register a passkey
 * *for* an account you're already logged into); authentication is
 * necessarily public (it's how you log in) but resolves its tenant the same
 * way `POST /oauth/authorize` does, via `client_id`.
 *
 * Follow-up to Phase 5 (ADR-0044): credential registration/deletion and
 * successful passkey authentication each record a fire-and-forget
 * `AuditEventBatcherService` entry - closing the gap ADR-0041 left open for
 * WebAuthn.
 */
@Controller('webauthn')
export class WebAuthnController {
  constructor(
    private readonly webauthn: WebAuthnService,
    private readonly credentials: WebAuthnCredentialsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly tenantContext: TenantContextService,
    private readonly oauthClientsRepository: OAuthClientsRepository,
    private readonly auditEvents: AuditEventBatcherService,
  ) {}

  @UseGuards(AccessTokenGuard)
  @Post('register/options')
  async registerOptions(@Req() req: RequestWithTokenClaims) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const user = await this.usersRepository.findOne({ where: { id: claims.sub } as never });
      return this.webauthn.generateRegistrationOptionsFor(claims.tenant_id, claims.sub, user!.email);
    });
  }

  @UseGuards(AccessTokenGuard)
  @Post('register/verify')
  async registerVerify(@Req() req: RequestWithTokenClaims, @Body() dto: RegisterVerifyDto) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      const credential = await this.webauthn.verifyRegistration(
        claims.tenant_id,
        claims.sub,
        dto.challengeId,
        dto.response as unknown as RegistrationResponseJSON,
        dto.deviceName ?? null,
      );
      this.auditEvents.enqueue({
        tenantId: claims.tenant_id,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'webauthn_credential.registered',
        resourceType: 'webauthn_credential',
        resourceId: credential.id,
        beforeState: null,
        afterState: { deviceName: credential.deviceName, deviceType: credential.deviceType },
        aiRationale: null,
      });
      return { id: credential.id, deviceName: credential.deviceName, createdAt: credential.createdAt };
    });
  }

  @UseGuards(AccessTokenGuard)
  @Get('credentials')
  async listCredentials(@Req() req: RequestWithTokenClaims) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, () => this.credentials.findForUser(claims.sub));
  }

  @UseGuards(AccessTokenGuard)
  @Delete('credentials/:id')
  async deleteCredential(@Req() req: RequestWithTokenClaims, @Param('id') id: string) {
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: claims.tenant_id }, async () => {
      await this.credentials.delete({ id, userId: claims.sub } as never);
      this.auditEvents.enqueue({
        tenantId: claims.tenant_id,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'webauthn_credential.deleted',
        resourceType: 'webauthn_credential',
        resourceId: id,
        beforeState: null,
        afterState: null,
        aiRationale: null,
      });
      return { deleted: true };
    });
  }

  @Post('authenticate/options')
  async authenticateOptions(@Body() dto: AuthenticateOptionsRequestDto) {
    const client = await this.resolveActiveClient(dto.client_id);
    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      const result = await this.webauthn.generateAuthenticationOptionsFor(client.tenantId, dto.email);
      if (!result) {
        // Same account-enumeration posture as PasswordAuthService: an
        // unregistered email or one with no passkeys yields an expired-
        // ceremony-shaped error, not "no such account."
        throw new WebAuthnChallengeExpiredError();
      }
      return result;
    });
  }

  @Post('authenticate/verify')
  async authenticateVerify(@Body() dto: AuthenticateVerifyDto): Promise<{ webauthn_session_token: string }> {
    const client = await this.resolveActiveClient(dto.client_id);
    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      const { token, userId } = await this.webauthn.verifyAuthentication(
        client.tenantId,
        dto.challengeId,
        dto.response as unknown as AuthenticationResponseJSON,
      );
      this.auditEvents.enqueue({
        tenantId: client.tenantId,
        actorId: userId,
        actorType: AuditActorType.USER,
        action: 'webauthn_authentication.succeeded',
        resourceType: 'user',
        resourceId: userId,
        beforeState: null,
        afterState: { client_id: client.clientId },
        aiRationale: null,
      });
      return { webauthn_session_token: token };
    });
  }

  private async resolveActiveClient(clientId: string) {
    const client = await this.oauthClientsRepository.findByClientId(clientId);
    if (!client || !client.isActive) {
      throw new InvalidClientError();
    }
    return client;
  }
}
