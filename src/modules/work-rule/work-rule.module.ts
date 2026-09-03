import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkRule } from './entities/work-rule.entity';
import { WorkRuleAssignment } from './entities/work-rule-assignment.entity';
import { WorkRulesRepository } from './repositories/work-rules.repository';
import { WorkRuleAssignmentsRepository } from './repositories/work-rule-assignments.repository';
import { WorkRulesService } from './services/work-rules.service';
import { WorkRuleResolver, EmployeeWorkRulesFieldResolver } from './graphql/work-rule.resolver';
import { EmployeeModule } from '../employee/employee.module';
import { EmployeeGroupModule } from '../employee-group/employee-group.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

/** Imports both `EmployeeModule` and `EmployeeGroupModule` (one direction only, neither imports this back) - `assign` validates whichever assignee type was given, `findForEmployee` needs group membership to resolve inherited rules. */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkRule, WorkRuleAssignment]),
    EmployeeModule,
    EmployeeGroupModule,
    AuthModule,
    AuditModule,
  ],
  providers: [
    WorkRulesRepository,
    WorkRuleAssignmentsRepository,
    WorkRulesService,
    WorkRuleResolver,
    EmployeeWorkRulesFieldResolver,
  ],
  exports: [TypeOrmModule, WorkRulesRepository, WorkRuleAssignmentsRepository, WorkRulesService],
})
export class WorkRuleModule {}
