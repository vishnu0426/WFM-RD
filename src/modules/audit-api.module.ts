import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuditLogController } from './audit/rest/audit-log.controller';

/**
 * Composition root for `GET /v1/audit-log` (§3.2) - `AuditLogController`
 * needs `AuditModule`'s `AuditLogRepository` *and* `AuthModule`'s
 * `AccessTokenGuard`/`PermissionsGuard`, and (as of the OAuth/SSO/SCIM/
 * WebAuthn instrumentation follow-up, ADR-0044) `AuthModule` itself now
 * imports `AuditModule`, so `AuditModule` importing `AuthModule` back would
 * be circular. Same `OrgApiModule`/`PolicyApiModule`/`IdentityApiModule`
 * pattern (ADR-0037) - this module owns the one controller that needs to
 * see across that boundary; neither `AuditModule` nor `AuthModule` depends
 * on this module.
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [AuditLogController],
})
export class AuditApiModule {}
