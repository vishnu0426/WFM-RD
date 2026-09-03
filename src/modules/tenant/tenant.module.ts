import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from './entities/tenant.entity';
import { TenantsRepository } from './repositories/tenants.repository';

/**
 * Tenant is RLS-protected (ADR-0007: self + BPO children + platform-admin),
 * but not via TenantScopedRepository - see TenantsRepository's doc comment
 * for why it needs its own guard shape instead of the generic one.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Tenant])],
  providers: [TenantsRepository],
  exports: [TypeOrmModule, TenantsRepository],
})
export class TenantModule {}
