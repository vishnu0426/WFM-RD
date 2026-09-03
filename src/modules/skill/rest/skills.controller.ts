import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { EmployeeSkillsService } from '../services/employee-skills.service';
import { EmployeeSkill } from '../entities/employee-skill.entity';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §3.2's two skill-related REST routes. Self-contained within `SkillModule`
 * (unlike `OrgUnitsController`/a hypothetical employee-CRUD REST surface) -
 * both just read `EmployeeSkill` rows, no cross-module existence check
 * needed: an unknown `employeeId` on `GET /v1/employees/{id}/skills` simply
 * returns an empty array, which is a reasonable response for a read-only
 * listing endpoint (no `EmployeeNotFoundError` 404, unlike the GraphQL
 * mutations that actually write data).
 *
 * Gated for the first time here (frontend Phase 1 prerequisite), same
 * `employee:read` reasoning as the GraphQL skill resolvers.
 */
@Controller('v1')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class SkillsController {
  constructor(private readonly employeeSkillsService: EmployeeSkillsService) {}

  @Get('employees/:id/skills')
  @RequirePermissions('employee:read')
  async getEmployeeSkills(@Param('id') employeeId: string): Promise<EmployeeSkill[]> {
    return this.employeeSkillsService.findForEmployee(employeeId);
  }

  @Get('skills/expiring')
  @RequirePermissions('employee:read')
  async getExpiringSkills(
    @Query('within_days') withinDays = '30',
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ): Promise<EmployeeSkill[]> {
    return this.employeeSkillsService.findExpiring(Number(withinDays), {
      limit: Number(limit),
      offset: Number(offset),
    });
  }
}
