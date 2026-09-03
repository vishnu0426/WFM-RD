import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ScorecardSourcesService } from '../scorecard-sources.service';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import {
  ScorecardDimensionMemberResult,
  ScorecardDimensionTypeResult,
  ScorecardSourceCodeResult,
  ScorecardSourceMappingResult,
  ScorecardSourceMeasureResult,
  ScorecardSourceSystemResult,
  toDimensionMemberResult,
  toDimensionTypeResult,
  toSourceCodeResult,
  toSourceMappingResult,
  toSourceMeasureResult,
  toSourceSystemResult,
} from './types';

function actorFromClaims(claims: AccessTokenClaims | undefined) {
  return { id: claims?.sub ?? null, type: 'user' as const };
}

const READ = 'scorecard_source:read';
const WRITE = 'scorecard_source:write';
const DELETE = 'scorecard_source:delete';

/** Tenant Admin Integration Management, WP6. One resolver for all six Scorecards Sources entities - see `ScorecardSourcesService`'s own doc comment for why one class, not six. */
@Resolver()
export class ScorecardSourceResolver {
  constructor(
    private readonly scorecards: ScorecardSourcesService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Source Systems
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardSourceSystemResult], { name: 'scorecardSourceSystems' })
  async sourceSystems(): Promise<ScorecardSourceSystemResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listSourceSystems(tenantId)).map(toSourceSystemResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardSourceSystemResult)
  async upsertScorecardSourceSystem(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('name') name: string,
    @Args('provider') provider: string,
    @Args('connectorId', { type: () => ID, nullable: true }) connectorId: string | null,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardSourceSystemResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertSourceSystem(tenantId, id ?? null, { name, provider, connectorId }, actorFromClaims(claims));
    return toSourceSystemResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardSourceSystem(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteSourceSystem(tenantId, id, actorFromClaims(claims));
    return true;
  }

  // Source Measures
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardSourceMeasureResult], { name: 'scorecardSourceMeasures' })
  async sourceMeasures(@Args('sourceSystemId', { type: () => ID }) sourceSystemId: string): Promise<ScorecardSourceMeasureResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listSourceMeasures(tenantId, sourceSystemId)).map(toSourceMeasureResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardSourceMeasureResult)
  async upsertScorecardSourceMeasure(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('sourceSystemId', { type: () => ID }) sourceSystemId: string,
    @Args('code') code: string,
    @Args('name') name: string,
    @Args('description', { type: () => String, nullable: true }) description: string | undefined,
    @Args('unit', { type: () => String, nullable: true }) unit: string | undefined,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardSourceMeasureResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertSourceMeasure(
      tenantId,
      id ?? null,
      { sourceSystemId, code, name, description, unit },
      actorFromClaims(claims),
    );
    return toSourceMeasureResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardSourceMeasure(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteSourceMeasure(tenantId, id, actorFromClaims(claims));
    return true;
  }

  // Source Codes
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardSourceCodeResult], { name: 'scorecardSourceCodes' })
  async sourceCodes(@Args('sourceSystemId', { type: () => ID }) sourceSystemId: string): Promise<ScorecardSourceCodeResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listSourceCodes(tenantId, sourceSystemId)).map(toSourceCodeResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardSourceCodeResult)
  async upsertScorecardSourceCode(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('sourceSystemId', { type: () => ID }) sourceSystemId: string,
    @Args('code') code: string,
    @Args('description', { type: () => String, nullable: true }) description: string | undefined,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardSourceCodeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertSourceCode(tenantId, id ?? null, { sourceSystemId, code, description }, actorFromClaims(claims));
    return toSourceCodeResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardSourceCode(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteSourceCode(tenantId, id, actorFromClaims(claims));
    return true;
  }

  // Source Mappings (F&S Queue Mappings reuses Campaign/CcQueue directly in the frontend, not this table - see plan decision #3)
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardSourceMappingResult], { name: 'scorecardSourceMappings' })
  async sourceMappings(@Args('sourceMeasureId', { type: () => ID }) sourceMeasureId: string): Promise<ScorecardSourceMappingResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listSourceMappings(tenantId, sourceMeasureId)).map(toSourceMappingResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardSourceMappingResult)
  async upsertScorecardSourceMapping(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('sourceMeasureId', { type: () => ID }) sourceMeasureId: string,
    @Args('targetMetric') targetMetric: string,
    @Args('description', { type: () => String, nullable: true }) description: string | undefined,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardSourceMappingResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertSourceMapping(
      tenantId,
      id ?? null,
      { sourceMeasureId, targetMetric, description },
      actorFromClaims(claims),
    );
    return toSourceMappingResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardSourceMapping(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteSourceMapping(tenantId, id, actorFromClaims(claims));
    return true;
  }

  // Dimension Types
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardDimensionTypeResult], { name: 'scorecardDimensionTypes' })
  async dimensionTypes(): Promise<ScorecardDimensionTypeResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listDimensionTypes(tenantId)).map(toDimensionTypeResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardDimensionTypeResult)
  async upsertScorecardDimensionType(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('name') name: string,
    @Args('description', { type: () => String, nullable: true }) description: string | undefined,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardDimensionTypeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertDimensionType(tenantId, id ?? null, { name, description }, actorFromClaims(claims));
    return toDimensionTypeResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardDimensionType(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteDimensionType(tenantId, id, actorFromClaims(claims));
    return true;
  }

  // Dimension Members
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(READ)
  @Query(() => [ScorecardDimensionMemberResult], { name: 'scorecardDimensionMembers' })
  async dimensionMembers(@Args('dimensionTypeId', { type: () => ID }) dimensionTypeId: string): Promise<ScorecardDimensionMemberResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return (await this.scorecards.listDimensionMembers(tenantId, dimensionTypeId)).map(toDimensionMemberResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(WRITE)
  @Mutation(() => ScorecardDimensionMemberResult)
  async upsertScorecardDimensionMember(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('dimensionTypeId', { type: () => ID }) dimensionTypeId: string,
    @Args('code') code: string,
    @Args('name') name: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ScorecardDimensionMemberResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.scorecards.upsertDimensionMember(tenantId, id ?? null, { dimensionTypeId, code, name }, actorFromClaims(claims));
    return toDimensionMemberResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions(DELETE)
  @Mutation(() => Boolean)
  async deleteScorecardDimensionMember(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.scorecards.deleteDimensionMember(tenantId, id, actorFromClaims(claims));
    return true;
  }
}
