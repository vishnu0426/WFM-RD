import { Module } from '@nestjs/common';
import { EmployeeGrpcController } from './controllers/employee-grpc.controller';
import { CalendarGrpcController } from './controllers/calendar-grpc.controller';
import { IdentityGrpcController } from './controllers/identity-grpc.controller';
import { PolicyGrpcController } from './controllers/policy-grpc.controller';
import { AuditGrpcController } from './controllers/audit-grpc.controller';
import { NotificationPreferenceGrpcController } from './controllers/notification-preference-grpc.controller';
import { EmployeeModule } from '../modules/employee/employee.module';
import { SkillModule } from '../modules/skill/skill.module';
import { CalendarModule } from '../modules/calendar/calendar.module';
import { AuthModule } from '../modules/auth/auth.module';
import { PolicyModule } from '../modules/policy/policy.module';
import { AuditModule } from '../modules/audit/audit.module';
import { NotificationModule } from '../modules/notification/notification.module';

/**
 * §3.3's internal gRPC surface for Scheduling/Forecasting (ADR-0021) plus
 * Module 01's own `IdentityService` (Phase 2), `PolicyService` (Phase 4),
 * `AuditService` (Phase 5), and `NotificationPreferenceService` (Module 11
 * Phase 5, ADR-0154) - the contracts every other internal service calls to
 * validate a token, fetch the caller's roles/permissions, resolve the
 * active policy for a given type/scope, record an audit event about that
 * service's own action, and check whether push is enabled for an employee.
 */
@Module({
  imports: [EmployeeModule, SkillModule, CalendarModule, AuthModule, PolicyModule, AuditModule, NotificationModule],
  controllers: [
    EmployeeGrpcController,
    CalendarGrpcController,
    IdentityGrpcController,
    PolicyGrpcController,
    AuditGrpcController,
    NotificationPreferenceGrpcController,
  ],
})
export class GrpcModule {}
