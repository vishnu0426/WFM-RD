import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { EmployeeAdherenceScoreQueryService } from '../../adherence/employee-adherence-score-query.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AdherenceScoreResult, toAdherenceScoreResult } from '../../adherence/types';

/**
 * Module 11 Phase 7 (docs/adr/0156): the mobile self-service Adherence
 * tab's "today's adherence %" source. No `date`/`periodType` argument by
 * design - this bakes "today only" into the schema itself rather than
 * relying on client discipline not to add a date picker later; a
 * historical trend is a materially bigger feature for a future phase.
 */
@Resolver(() => AdherenceScoreResult)
export class AdherenceScoreResolver {
  constructor(
    private readonly employeeAdherenceScoreQuery: EmployeeAdherenceScoreQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `null` (not a fabricated `0%`) when the employee has had no
   * `adherence_event` rows yet today - indistinguishable from "recorded
   * and fully non-adherent" otherwise. */
  @Query(() => AdherenceScoreResult, { name: 'adherenceScoreToday', nullable: true })
  async adherenceScoreToday(
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<AdherenceScoreResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const score = await this.employeeAdherenceScoreQuery.getTodayScore(tenantId, employeeId);
    return score ? toAdherenceScoreResult(score) : null;
  }
}
