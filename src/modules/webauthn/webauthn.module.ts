import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { WebAuthnCredentialsRepository } from './repositories/webauthn-credentials.repository';
import { WebAuthnChallengeService } from './services/webauthn-challenge.service';
import { WebAuthnService } from './services/webauthn.service';
import { WebAuthnController } from './rest/webauthn.controller';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Module 01 Phase 3 (§8, §5.4): WebAuthn/Passkeys. See docs/phase-3-design-doc.md.
 *
 * Follow-up to Phase 5 (ADR-0044): imports `AuditModule` so
 * `WebAuthnController` can record credential registration/deletion and
 * successful passkey authentication - closing the gap ADR-0041 left open
 * for WebAuthn. No cycle risk: `AuditModule` depends on neither `AuthModule`
 * nor `IdentityModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebAuthnCredential]), AuthModule, IdentityModule, AuditModule],
  providers: [WebAuthnCredentialsRepository, WebAuthnChallengeService, WebAuthnService],
  controllers: [WebAuthnController],
})
export class WebAuthnModule {}
