import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OrgHierarchyService } from '../services/org-hierarchy.service';
import { OrgUnitSnapshotType } from '../graphql/org-unit-snapshot.type';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §3.2: `GET /v1/org-units/{id}/tree?as_of=<date>`. REST is reserved for
 * bulk/integration operations per the mandated stack (§1) - general
 * CRUD (`createOrgUnit`/`updateOrgUnit`) is GraphQL-only (`OrgUnitResolver`);
 * this is the one REST-specific surface §3.2 actually names for org
 * hierarchy. Shares `OrgHierarchyService` with the GraphQL
 * `orgHierarchy` query rather than reimplementing the as-of logic here.
 *
 * Gated for the first time here (frontend Phase 1 prerequisite), same
 * `employee:read` reasoning as `OrgUnitResolver`'s own doc comment.
 */
@Controller('v1/org-units')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class OrgUnitsController {
  constructor(private readonly orgHierarchyService: OrgHierarchyService) {}

  @Get(':id/tree')
  @RequirePermissions('employee:read')
  async getTree(@Param('id') id: string, @Query('as_of') asOf?: string): Promise<OrgUnitSnapshotType> {
    return this.orgHierarchyService.getHierarchy(id, asOf ? new Date(asOf) : undefined);
  }
}
