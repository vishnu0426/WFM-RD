import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Policy } from './entities/policy.entity';
import { PoliciesRepository } from './repositories/policies.repository';
import { SystemLimitsPolicyService } from './services/system-limits-policy.service';

/**
 * Standalone (not `PolicyModule` itself) specifically to avoid a circular
 * import: `PolicyModule` already imports `OrgUnitModule`
 * (`policy.module.ts`'s own doc comment explains why), and
 * `OrgUnitsService.create` needs `SystemLimitsPolicyService` — importing
 * `PolicyModule` from `OrgUnitModule` would cycle back. `PoliciesRepository`
 * is stateless (just `DataSource`/`TenantContextService`), so a second,
 * independent provider instance here is harmless.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Policy])],
  providers: [PoliciesRepository, SystemLimitsPolicyService],
  exports: [SystemLimitsPolicyService],
})
export class SystemLimitsModule {}
