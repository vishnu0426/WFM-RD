import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

/** `@Global()` so every resolver/controller/service can inject `TenantContextService` without re-importing this module. */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantContextModule {}
