import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { AuthorizationCodesRepository } from '../repositories/authorization-codes.repository';
import { AuthorizationCode } from '../entities/authorization-code.entity';
import { InvalidGrantError } from '../errors/invalid-grant.error';

// Short-lived by design (RFC 6749 §4.1.2 recommends 10 min max; this
// platform uses a tighter window since the code is meant to be exchanged
// immediately after the redirect, not held).
const CODE_TTL_SECONDS = 60;

export interface IssueAuthorizationCodeInput {
  tenantId: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  nonce: string | null;
  authTime: Date;
  amr: string[];
}

@Injectable()
export class AuthorizationCodeService {
  constructor(private readonly authorizationCodesRepository: AuthorizationCodesRepository) {}

  async issue(input: IssueAuthorizationCodeInput): Promise<string> {
    const code = this.generateCode();
    await this.authorizationCodesRepository.save({
      codeHash: this.hash(code),
      tenantId: input.tenantId,
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: input.scope,
      nonce: input.nonce,
      authTime: input.authTime,
      amr: input.amr,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
      consumedAt: null,
    } as AuthorizationCode);
    return code;
  }

  /** Consumes (single-use, RFC 6749 §4.1.2) and validates the code belongs to `clientId`/`redirectUri`. */
  async consume(code: string, clientId: string, redirectUri: string): Promise<AuthorizationCode> {
    const record = await this.authorizationCodesRepository.consume(this.hash(code));
    if (!record) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or already used.');
    }
    if (record.clientId !== clientId) {
      throw new InvalidGrantError('Authorization code was not issued to this client.');
    }
    if (record.redirectUri !== redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the one used to obtain this code.');
    }
    return record;
  }

  private generateCode(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
