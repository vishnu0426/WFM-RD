import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { PermissionsGuard } from './permissions.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from './ai-interaction-rate-limit.guard';
import { AiInteractionRateLimiterService } from './ai-interaction-rate-limiter.service';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * Phase 9 (docs/adr/0133): a proper NestJS module for `src/auth/`, matching
 * every other concern in this service (`ai/`, `graphql/`, `grpc/`, `nats/`)
 * - previously, `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`
 * were registered as three separate loose providers directly in
 * `AiGraphQLModule`, the only concern in this codebase without its own
 * module. `RequirePermissions`/`CurrentTokenClaims` are plain decorator
 * factories, not providers - nothing to register for either.
 *
 * ADR-0162 adds `AiInteractionRateLimitGuard`/`AiInteractionRateLimiterService` -
 * co-located here rather than in `AiModule` since the guard is this
 * module's own concern (used via `@UseGuards(...)` next to the other
 * three) and the limiter has no other consumer.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
    AiInteractionRateLimiterService,
    AiInteractionRateLimitGuard,
  ],
  exports: [
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
    AiInteractionRateLimiterService,
    AiInteractionRateLimitGuard,
  ],
})
export class AuthModule {}
