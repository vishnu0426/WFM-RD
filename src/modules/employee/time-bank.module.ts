import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeBankEntry } from './entities/time-bank-entry.entity';
import { TimeBankEntriesRepository } from './repositories/time-bank-entries.repository';
import { TimeBankResolver } from './graphql/time-bank.resolver';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

/**
 * A leaf module (imports nothing employee-shaped back) — deliberately not
 * folded into `EmployeeModule` itself, same reasoning `SkillModule` already
 * applies to keep the employee-adjacent sub-resource surface area from all
 * growing inside one module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TimeBankEntry]), AuthModule, AuditModule],
  providers: [TimeBankEntriesRepository, TimeBankResolver],
  exports: [TypeOrmModule, TimeBankEntriesRepository],
})
export class TimeBankModule {}
