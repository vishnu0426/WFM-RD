import { Injectable } from '@nestjs/common';
import { OAuthClientsRepository } from '../repositories/oauth-clients.repository';
import { PasswordHasherService } from './password-hasher.service';
import { OAuthClient } from '../entities/oauth-client.entity';
import { OAuthClientType } from '../entities/oauth-client-type.enum';
import { OAuthGrantType } from '../entities/oauth-grant-type.enum';
import { InvalidClientError } from '../errors/invalid-client.error';
import { UnauthorizedClientError } from '../errors/unauthorized-client.error';
import { OAuthInvalidRequestError } from '../errors/invalid-request.error';

/**
 * RFC 6749 §2.3 client authentication + §3.1.2.3 redirect_uri exact-match
 * validation (no wildcards/prefix matching - a documented OAuth2.1 hardening
 * requirement, since prefix matching is a well-known open-redirect vector).
 */
@Injectable()
export class OAuthClientAuthService {
  constructor(
    private readonly oauthClientsRepository: OAuthClientsRepository,
    private readonly passwordHasher: PasswordHasherService,
  ) {}

  async authenticate(clientId: string, clientSecret: string | null): Promise<OAuthClient> {
    const client = await this.oauthClientsRepository.findByClientId(clientId);
    if (!client || !client.isActive) {
      throw new InvalidClientError();
    }
    if (client.clientType === OAuthClientType.CONFIDENTIAL) {
      if (!clientSecret || !client.clientSecretHash) {
        throw new InvalidClientError('Confidential clients must present a client_secret.');
      }
      const valid = await this.passwordHasher.verify(clientSecret, client.clientSecretHash);
      if (!valid) {
        throw new InvalidClientError();
      }
    }
    return client;
  }

  assertGrantTypeAllowed(client: OAuthClient, grantType: OAuthGrantType): void {
    if (!client.allowedGrantTypes.includes(grantType)) {
      throw new UnauthorizedClientError(`Client ${client.clientId} is not authorized for grant_type ${grantType}.`);
    }
  }

  assertRedirectUriRegistered(client: OAuthClient, redirectUri: string): void {
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthInvalidRequestError('redirect_uri does not match any URI registered for this client.');
    }
  }
}
