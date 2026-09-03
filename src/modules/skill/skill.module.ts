import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from './entities/skill.entity';
import { EmployeeSkill } from './entities/employee-skill.entity';
import { EmployeeSkillHistory } from './entities/employee-skill-history.entity';
import { DecayJobRun } from './entities/decay-job-run.entity';
import { SkillsRepository } from './repositories/skills.repository';
import { EmployeeSkillsRepository } from './repositories/employee-skills.repository';
import { EmployeeSkillHistoryRepository } from './repositories/employee-skill-history.repository';
import { DecayJobRunsRepository } from './repositories/decay-job-runs.repository';
import { SkillsService } from './services/skills.service';
import { EmployeeSkillsService } from './services/employee-skills.service';
import { SkillDecayJobService } from './services/skill-decay-job.service';
import { SkillDecaySchedulerService } from './services/skill-decay-scheduler.service';
import { SkillResolver, EmployeeSkillFieldResolver } from './graphql/skill.resolver';
import { EmployeeSkillsFieldResolver } from './graphql/employee-skills.resolver';
import { SkillsController } from './rest/skills.controller';
import { EmployeeModule } from '../employee/employee.module';
import { PolicyModule } from '../policy/policy.module';
import { CalendarModule } from '../calendar/calendar.module';
import { NotificationModule } from '../notification/notification.module';
import { EventingModule } from '../eventing/eventing.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Imports `EmployeeModule` (one direction only, same shape as
 * `EmployeeModule -> OrgUnitModule`): the decay job needs
 * `EmployeesRepository`/`EmployeeHistoryRepository`, and
 * `EmployeeSkillsService` needs `EmployeesService` to validate
 * `updateEmployeeSkills`' `employeeId`. `PolicyModule`/`CalendarModule`/
 * `NotificationModule` back the decay job's half-life lookup, tenant-local
 * scheduling window, and certification-alert recipient lookup respectively
 * (ADR-0017). None of these four import `SkillModule` back.
 *
 * `AuthModule` added (frontend Phase 1 prerequisite, for gating the skill
 * resolvers/controller) - no cycle risk, `AuthModule` doesn't import
 * `SkillModule` (unlike its `PolicyModule` import, which is why
 * `EmploymentPolicyResolver` needed the `PolicyApiModule` workaround
 * instead of a direct import here).
 *
 * `AuditModule` added for GAP-06 (enterprise readiness audit, 2026-08-18):
 * `SkillsService`/`EmployeeSkillsService` now inject `AuditLogRepository`
 * directly - no cycle risk, same as every other module's own addition.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Skill, EmployeeSkill, EmployeeSkillHistory, DecayJobRun]),
    EmployeeModule,
    PolicyModule,
    CalendarModule,
    NotificationModule,
    EventingModule,
    AuthModule,
    AuditModule,
  ],
  providers: [
    SkillsRepository,
    EmployeeSkillsRepository,
    EmployeeSkillHistoryRepository,
    DecayJobRunsRepository,
    SkillsService,
    EmployeeSkillsService,
    SkillDecayJobService,
    SkillDecaySchedulerService,
    SkillResolver,
    EmployeeSkillFieldResolver,
    EmployeeSkillsFieldResolver,
  ],
  controllers: [SkillsController],
  exports: [TypeOrmModule, SkillsRepository, EmployeeSkillsRepository, SkillsService, EmployeeSkillsService],
})
export class SkillModule {}
