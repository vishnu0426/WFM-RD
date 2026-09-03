import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { ComplianceRuleService } from '../compliance-rule.service';
import { RuleChangeImpactPreview } from '../entities/rule-change-impact-preview.entity';
import { EmployeeGrpcClientService } from '../../grpc/employee-grpc-client.service';
import { ScheduleQueryGrpcClientService } from '../../grpc/schedule-query-grpc-client.service';
import { isCompliant, SimulatedShift } from './evaluate-schedule-compliance';

/**
 * §5a/docs/adr/0104: "currently-published schedules" needs a concrete
 * window, not an unbounded one - 28 days ahead of today, wide enough to
 * cover a typical publish horizon without pulling a whole schedule
 * lifetime's worth of assignments for a preview. A real, disclosed
 * default, not derived from anything in the module prompt.
 */
const IMPACT_PREVIEW_WINDOW_DAYS = 28;

/**
 * §5a's real simulation, deferred from Phase 1's schema-only cut: "would
 * this rule change make anyone who is compliant today become non-compliant."
 * Not "is anyone non-compliant under the proposed rule" outright - a rule
 * that is simply stricter than *nothing* (no currently-active rule for this
 * jurisdiction/ruleType at all) still only counts employees who cross from
 * compliant to non-compliant, matching `wouldBecomeNoncompliantCount`'s own
 * name.
 *
 * The caller supplies `orgUnitIds` rather than this service resolving
 * "which org units fall under this rule's jurisdiction" itself -
 * `ComplianceRule` has no org-unit scope at all (only `jurisdiction`, a
 * country/subdivision code), and there is no existing RPC anywhere in this
 * platform that maps a jurisdiction to a set of org units. Resolving that
 * is Module 02's own domain (`OrgUnit.countryCode`), not this module's -
 * out of scope per §8's own "not rewriting Module 02's internal logic
 * beyond the integration points" non-goal. The caller (an admin UI that
 * already knows which org units it manages) supplies the scope explicitly,
 * the same posture ADR-0101/0102 already took for jurisdiction resolution
 * on the Module 02/04 integration points.
 */
@Injectable()
export class RuleChangeImpactPreviewService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly complianceRuleService: ComplianceRuleService,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly scheduleQueryGrpcClient: ScheduleQueryGrpcClientService,
  ) {}

  async generatePreview(tenantId: string, ruleId: string, orgUnitIds: string[]): Promise<RuleChangeImpactPreview> {
    const rule = await this.complianceRuleService.getOwnedRule(tenantId, ruleId);

    const baseline = await this.complianceRuleService.getActiveRule(
      tenantId,
      rule.jurisdiction,
      rule.ruleType,
      new Date(),
    );

    const rosterEntries = (
      await Promise.all(
        orgUnitIds.map((orgUnitId) => this.employeeGrpcClient.getSchedulableRoster(tenantId, orgUnitId)),
      )
    ).flat();
    const employeeIds = [...new Set(rosterEntries.map((entry) => entry.employeeId))];
    const orgUnitIdByEmployeeId = new Map(rosterEntries.map((entry) => [entry.employeeId, entry.orgUnitId]));

    const windowStart = new Date();
    windowStart.setUTCHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + IMPACT_PREVIEW_WINDOW_DAYS);

    const records = await this.scheduleQueryGrpcClient.listPublishedShiftAssignments(
      tenantId,
      employeeIds,
      windowStart,
      windowEnd,
    );

    const scheduleIds = new Set<string>();
    const shiftsByEmployeeId = new Map<string, SimulatedShift[]>();
    for (const record of records) {
      scheduleIds.add(record.scheduleId);
      const shifts = shiftsByEmployeeId.get(record.employeeId) ?? [];
      shifts.push({
        employeeId: record.employeeId,
        start: new Date(record.shiftStart),
        end: new Date(record.shiftEnd),
      });
      shiftsByEmployeeId.set(record.employeeId, shifts);
    }

    const affectedEmployeeIds: string[] = [];
    for (const employeeId of employeeIds) {
      const shifts = shiftsByEmployeeId.get(employeeId) ?? [];
      const wasCompliant = baseline ? isCompliant(rule.ruleType, baseline.definition, shifts) : true;
      const staysCompliant = isCompliant(rule.ruleType, rule.definition, shifts);
      if (wasCompliant && !staysCompliant) {
        affectedEmployeeIds.push(employeeId);
      }
    }
    const affectedOrgUnitIds = [
      ...new Set(
        affectedEmployeeIds
          .map((employeeId) => orgUnitIdByEmployeeId.get(employeeId))
          .filter((orgUnitId): orgUnitId is string => orgUnitId !== undefined),
      ),
    ];

    const preview: RuleChangeImpactPreview = {
      id: randomUUID(),
      tenantId,
      complianceRuleId: ruleId,
      simulatedAgainstScheduleIds: [...scheduleIds],
      wouldBecomeNoncompliantCount: affectedEmployeeIds.length,
      affectedEmployeeIds,
      affectedOrgUnitIds,
      generatedAt: new Date(),
    };

    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.insert(RuleChangeImpactPreview, preview),
    );
    return preview;
  }
}
