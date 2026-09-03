import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeGroup } from './entities/employee-group.entity';
import { EmployeeGroupMember } from './entities/employee-group-member.entity';
import { EmployeeGroupsRepository } from './repositories/employee-groups.repository';
import { EmployeeGroupMembersRepository } from './repositories/employee-group-members.repository';
import { EmployeeGroupsService } from './services/employee-groups.service';
import { EmployeeGroupResolver, EmployeeGroupsFieldResolver } from './graphql/employee-group.resolver';
import { EmployeeModule } from '../employee/employee.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Imports `EmployeeModule` (one direction only, same shape as
 * `SkillModule -> EmployeeModule`): `addMember` needs `EmployeesService` to
 * validate `employeeId`. `WorkRuleModule` imports this module back (for
 * group-based rule resolution) - no cycle, since this module never imports
 * `WorkRuleModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmployeeGroup, EmployeeGroupMember]), EmployeeModule, AuthModule, AuditModule],
  providers: [
    EmployeeGroupsRepository,
    EmployeeGroupMembersRepository,
    EmployeeGroupsService,
    EmployeeGroupResolver,
    EmployeeGroupsFieldResolver,
  ],
  exports: [TypeOrmModule, EmployeeGroupsRepository, EmployeeGroupMembersRepository, EmployeeGroupsService],
})
export class EmployeeGroupModule {}
