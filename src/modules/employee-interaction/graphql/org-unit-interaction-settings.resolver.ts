import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { OrgUnitInteractionSettingsGraphQLType } from './org-unit-interaction-settings.type';
import { OrgUnitInteractionSettingsService } from '../services/org-unit-interaction-settings.service';
import { UpsertOrgUnitInteractionSettingsInput } from '../dto/upsert-org-unit-interaction-settings.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Reuses `employee:read`/`employee:write`, same disclosed precedent `EmployeeInteractionResolver` already states. */
@Resolver(() => OrgUnitInteractionSettingsGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class OrgUnitInteractionSettingsResolver {
  constructor(private readonly service: OrgUnitInteractionSettingsService) {}

  /** The effective, inheritance-resolved settings for this org unit — what the Interactions screen's "Inherit from current organization" section should actually render. */
  @Query(() => OrgUnitInteractionSettingsGraphQLType)
  @RequirePermissions('employee:read')
  async orgUnitInteractionSettings(
    @Args('orgUnitId', { type: () => ID }) orgUnitId: string,
  ): Promise<OrgUnitInteractionSettingsGraphQLType> {
    return this.service.resolveEffective(orgUnitId);
  }

  @Mutation(() => OrgUnitInteractionSettingsGraphQLType)
  @RequirePermissions('employee:write')
  async upsertOrgUnitInteractionSettings(
    @Args('input') input: UpsertOrgUnitInteractionSettingsInput,
  ): Promise<OrgUnitInteractionSettingsGraphQLType> {
    await this.service.upsertForOrgUnit(input);
    return this.service.resolveEffective(input.orgUnitId);
  }
}
