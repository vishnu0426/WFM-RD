import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './entities/employee.entity';
import { EmployeeHistory } from './entities/employee-history.entity';
import { ErasureRequest } from './entities/erasure-request.entity';
import { EmployeeDataSource } from './entities/employee-data-source.entity';
import { EmployeesRepository } from './repositories/employees.repository';
import { EmployeeHistoryRepository } from './repositories/employee-history.repository';
import { ErasureRequestsRepository } from './repositories/erasure-requests.repository';
import { EmployeeDataSourcesRepository } from './repositories/employee-data-sources.repository';
import { EmployeesService } from './services/employees.service';
import { ErasureRequestsService } from './services/erasure-requests.service';
import { EmployeeDataSourcesService } from './services/employee-data-sources.service';
import { ErasureRequestResolver } from './graphql/erasure-request.resolver';
import { EmployeeDataSourceResolver, EmployeeDataSourcesFieldResolver } from './graphql/employee-data-source.resolver';
import { ErasureRequestsController } from './rest/erasure-requests.controller';
import { EmployeeTaxIdController } from './rest/employee-tax-id.controller';
import { EmployeeAvatarController } from './rest/employee-avatar.controller';
import { OrgUnitModule } from '../org-unit/org-unit.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { SystemLimitsModule } from '../policy/system-limits.module';

/**
 * Imports `AuthModule` (frontend Phase 1 prerequisite, for gating
 * `ErasureRequestResolver`/`ErasureRequestsController` - a mutation that
 * triggers irreversible PII anonymization had no guard at all) - no cycle
 * risk, `AuthModule` doesn't import `EmployeeModule`.
 *
 * Imports `OrgUnitModule` (one direction only) so `EmployeesService` can
 * validate a referenced `orgUnitId` via `OrgUnitsService` - safe because
 * `OrgUnitModule` has no reverse dependency on `EmployeeModule` (see
 * `OrgApiModule`'s doc comment for why the *resolvers*, which need both
 * directions, live in a separate composition module instead of either of
 * these importing each other). `ErasureRequestsRepository.completeAndAnonymize`
 * reaches `OutboxEventsRepository.insertWithinTransaction` and `AuditLog` the
 * same way `EmployeesRepository.createWithOutboxEvent` reaches the outbox -
 * a plain ES import and `manager.getRepository(AuditLog)` against the
 * app-wide `DataSource`, not Nest DI, so that specific write needs no
 * module-graph edge.
 *
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): imports `AuditModule`
 * (for `AuditLogRepository`, no cycle risk - `AuditModule` doesn't import
 * `EmployeeModule`) so `EmployeeResolver`'s create/update/transfer mutations
 * and `ErasureRequestResolver`/`ErasureRequestsController`'s create/approve/
 * reject actions (`completeAndAnonymize`'s own direct write was already the
 * one exception) can record through the same DI-based path every other
 * audited resolver/controller uses.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, EmployeeHistory, ErasureRequest, EmployeeDataSource]),
    OrgUnitModule,
    AuthModule,
    AuditModule,
    SystemLimitsModule,
  ],
  providers: [
    EmployeesRepository,
    EmployeeHistoryRepository,
    ErasureRequestsRepository,
    EmployeeDataSourcesRepository,
    EmployeesService,
    ErasureRequestsService,
    EmployeeDataSourcesService,
    ErasureRequestResolver,
    EmployeeDataSourceResolver,
    EmployeeDataSourcesFieldResolver,
  ],
  controllers: [ErasureRequestsController, EmployeeTaxIdController, EmployeeAvatarController],
  exports: [TypeOrmModule, EmployeesRepository, EmployeeHistoryRepository, ErasureRequestsRepository, EmployeesService, EmployeeDataSourcesService],
})
export class EmployeeModule {}
