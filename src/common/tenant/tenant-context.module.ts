import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/**
 * Global so every feature module can inject TenantContextService without
 * re-importing it - it's pure request-scoped state (via AsyncLocalStorage),
 * not a per-module concern.
 */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantContextModule {}
