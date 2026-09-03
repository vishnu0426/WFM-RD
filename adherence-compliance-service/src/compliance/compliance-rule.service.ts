import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ComplianceRule, ComplianceRuleStatus, ComplianceRuleType } from './entities/compliance-rule.entity';
import { CreateComplianceRuleInput } from './types';
import { ComplianceRuleNotFoundError } from './errors/compliance-rule-not-found.error';
import { ComplianceRuleNotPendingReviewError } from './errors/compliance-rule-not-pending-review.error';
import { ComplianceRuleCitationRequiredError } from './errors/compliance-rule-citation-required.error';
import { InvalidComplianceRuleEffectiveRangeError } from './errors/invalid-compliance-rule-effective-range.error';
import { ComplianceRuleNotOwnedError } from './errors/compliance-rule-not-owned.error';
import { ImpactPreviewRequiredError } from './errors/impact-preview-required.error';
import { ActivationJustificationRequiredError } from './errors/activation-justification-required.error';
import { resolveEffectiveRules } from './resolve-effective-rules';
import { MetricsService } from '../common/metrics/metrics.service';
import { RuleChangeImpactPreview } from './entities/rule-change-impact-preview.entity';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';

/**
 * §7 Phase 2: "basic rule management" - CRUD plus citation enforcement,
 * nothing more. Explicitly NOT built here (see the Phase 2 design doc):
 * the §2.2-rule-3 "is this override at least as strict as the floor"
 * comparison (Phase 4's `ValidatePolicyAgainstFloor`, ADR-0095's flagged
 * gap - this phase leans on the mandatory human-review gate below instead),
 * `RuleChangeImpactPreview` (Phase 5), and any RBAC/permission check on who
 * may call `activateRule` (Module 01 integration is out of scope for this
 * module entirely per §8).
 */
@Injectable()
export class ComplianceRuleService {
  private readonly logger = new Logger(ComplianceRuleService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly auditGrpcClient: AuditGrpcClientService,
  ) {}

  /**
   * §5a: always inserts `status: 'pending_review'` - never active on
   * creation, no matter what the caller passes (the input type doesn't even
   * expose a status field). §2.2 rule 3/ADR-0097: always tenant-scoped -
   * there is no code path here that can write a `tenantId: null` platform-
   * default row; even if there were, Postgres RLS's own `WITH CHECK` would
   * reject it (verified in Phase 1).
   */
  async createRule(tenantId: string, input: CreateComplianceRuleInput): Promise<ComplianceRule> {
    const citation = input.citation.trim();
    if (citation.length === 0) {
      this.metrics.recordComplianceRuleCreation('rejected');
      throw new ComplianceRuleCitationRequiredError();
    }
    if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      this.metrics.recordComplianceRuleCreation('rejected');
      throw new InvalidComplianceRuleEffectiveRangeError();
    }

    try {
      const rule = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        // Must run on this same transaction's manager, not a fresh
        // connection/query runner - a separate connection would have no
        // app.current_tenant_id bound, and RLS's default-deny-when-unset
        // posture would make this SELECT see zero rows regardless of what
        // this tenant actually has, silently forcing every rule back to
        // version 1.
        const version = await this.nextVersion(manager, tenantId, input.jurisdiction, input.ruleType);
        const id = randomUUID();
        await manager.insert(ComplianceRule, {
          id,
          tenantId,
          jurisdiction: input.jurisdiction,
          ruleType: input.ruleType,
          definition: asJsonbValue(input.definition),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          version,
          citation,
          status: ComplianceRuleStatus.PENDING_REVIEW,
          activationDelayUntil: null,
          createdAt: new Date(),
          activatedAt: null,
        });
        return manager.findOneByOrFail(ComplianceRule, { id });
      });
      this.metrics.recordComplianceRuleCreation('accepted');
      return rule;
    } catch (err) {
      this.metrics.recordComplianceRuleCreation('error');
      throw err;
    }
  }

  /**
   * §5a's go-live step - a separate, explicit call from `createRule`, so
   * activation is never an accidental side effect of creation. Supersedes
   * any other currently-`active` row in the same (`tenantId`, `jurisdiction`,
   * `ruleType`) scope: without this, `resolveEffectiveRules` could see two
   * simultaneously-`active` rows for the same scope, which its own
   * one-row-per-`ruleType` contract assumes never happens.
   *
   * `effectiveAt` (§0.5's progressive-delivery field, `activationDelayUntil`
   * in the schema): when provided, the rule's status flips to `active` now
   * (it is reviewed and approved) but does not count as actually in force
   * until that timestamp - `resolveEffectiveRules` is what enforces this
   * distinction on the read side.
   *
   * Phase 5 (docs/adr/0104): also requires at least one `RuleChangeImpactPreview`
   * row for this rule - "only after the admin has reviewed a
   * RuleChangeImpactPreview" (this entity's own doc comment), enforced as
   * "one exists," not merely "the caller says they looked." A flagged
   * (`wouldBecomeNoncompliantCount > 0`) preview does NOT block activation
   * - it is advisory, not a hard gate, matching §5a's own framing of this
   * as a governance/visibility feature, not a second `ValidatePolicyAgainstFloor`.
   * Activation still proceeds, but a best-effort audit event is recorded
   * afterward (never blocks or rolls back an activation that already
   * committed) and the governance metric is incremented.
   *
   * `justificationNote`: required (`ActivationJustificationRequiredError`
   * otherwise) whenever the latest preview flagged non-compliant schedules -
   * the override frontend prompt calls for ("a deliberate, documented
   * decision") enforced server-side rather than trusted to the caller's own
   * confirmation UI. Optional and ignored when nothing was flagged, so an
   * ordinary (unflagged) activation is unaffected.
   */
  async activateRule(
    tenantId: string,
    ruleId: string,
    effectiveAt?: Date,
    justificationNote?: string,
  ): Promise<ComplianceRule> {
    let flaggedNoncompliantCount = 0;
    try {
      const rule = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        const existing = await manager.findOne(ComplianceRule, { where: { id: ruleId } });
        if (!existing) {
          throw new ComplianceRuleNotFoundError(ruleId);
        }
        // RLS's own SELECT policy lets this tenant read a platform-default
        // row too (ADR-0095) - reject that case explicitly with a clean
        // error rather than letting the UPDATE below fail on the RLS
        // WITH CHECK clause instead.
        if (existing.tenantId !== tenantId) {
          throw new ComplianceRuleNotOwnedError(ruleId);
        }
        if (existing.status !== ComplianceRuleStatus.PENDING_REVIEW) {
          throw new ComplianceRuleNotPendingReviewError(ruleId, existing.status);
        }

        const [latestPreview] = await manager.find(RuleChangeImpactPreview, {
          where: { complianceRuleId: ruleId },
          order: { generatedAt: 'DESC' },
          take: 1,
        });
        if (!latestPreview) {
          throw new ImpactPreviewRequiredError(ruleId);
        }
        flaggedNoncompliantCount = latestPreview.wouldBecomeNoncompliantCount;
        if (flaggedNoncompliantCount > 0 && !justificationNote?.trim()) {
          throw new ActivationJustificationRequiredError(ruleId);
        }

        await manager.update(
          ComplianceRule,
          {
            tenantId,
            jurisdiction: existing.jurisdiction,
            ruleType: existing.ruleType,
            status: ComplianceRuleStatus.ACTIVE,
          },
          { status: ComplianceRuleStatus.SUPERSEDED },
        );
        await manager.update(
          ComplianceRule,
          { id: ruleId },
          {
            status: ComplianceRuleStatus.ACTIVE,
            activatedAt: new Date(),
            activationDelayUntil: effectiveAt ?? null,
          },
        );
        return manager.findOneByOrFail(ComplianceRule, { id: ruleId });
      });
      this.metrics.recordComplianceRuleActivation('activated');
      if (flaggedNoncompliantCount > 0) {
        this.metrics.recordImpactPreviewFlaggedButActivated();
        await this.recordFlaggedActivationAudit(tenantId, rule, flaggedNoncompliantCount, justificationNote as string);
      }
      return rule;
    } catch (err) {
      this.metrics.recordComplianceRuleActivation(
        err instanceof ComplianceRuleNotFoundError ||
          err instanceof ComplianceRuleNotOwnedError ||
          err instanceof ComplianceRuleNotPendingReviewError ||
          err instanceof ImpactPreviewRequiredError ||
          err instanceof ActivationJustificationRequiredError
          ? 'rejected'
          : 'error',
      );
      throw err;
    }
  }

  /**
   * Best-effort, fired after the activation transaction has already
   * committed - a failure here must never make `activateRule` itself
   * throw (the activation already happened; there is nothing left to roll
   * back), same posture ADR-0079's own `DecideLeaveRequestService.auditBackdatedDecision`
   * takes for its own post-commit audit call.
   */
  private async recordFlaggedActivationAudit(
    tenantId: string,
    rule: ComplianceRule,
    wouldBecomeNoncompliantCount: number,
    justificationNote: string,
  ): Promise<void> {
    try {
      await this.auditGrpcClient.recordEvent({
        tenantId,
        actorId: '',
        actorType: 'system',
        action: 'compliance_rule_activated_despite_noncompliance',
        resourceType: 'compliance_rule',
        resourceId: rule.id,
        beforeStateJson: '',
        afterStateJson: JSON.stringify({ status: rule.status, wouldBecomeNoncompliantCount, justificationNote }),
        aiRationaleJson: '',
      });
    } catch (err) {
      this.logger.warn(`Failed to record activation audit event for rule ${rule.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Phase 5 (docs/adr/0104): the same "does this rule exist and belong to
   * this tenant" check `activateRule` already inlines, exposed for
   * `RuleChangeImpactPreviewService` to call before it starts pulling
   * roster/schedule data for a rule this tenant doesn't even own. Not
   * shared as a private helper with `activateRule` - that method's checks
   * run inside one transaction alongside the supersede/update calls, while
   * this is a standalone read with no write to follow in the same
   * transaction.
   */
  async getOwnedRule(tenantId: string, ruleId: string): Promise<ComplianceRule> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(ComplianceRule, { where: { id: ruleId } });
      if (!existing) {
        throw new ComplianceRuleNotFoundError(ruleId);
      }
      if (existing.tenantId !== tenantId) {
        throw new ComplianceRuleNotOwnedError(ruleId);
      }
      return existing;
    });
  }

  /** §3.1's `complianceRules(jurisdiction)` - the admin management view: every rule visible to this tenant (its own, any status, plus the platform default via RLS), not just what's currently in effect. */
  async listRules(tenantId: string, jurisdiction: string): Promise<ComplianceRule[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(ComplianceRule, {
        where: { jurisdiction },
        order: { ruleType: 'ASC', version: 'DESC' },
      }),
    );
  }

  /** §3.2's `GET /v1/compliance/rules/{jurisdiction}` - what's actually in effect right now, one row per `ruleType`. See `resolveEffectiveRules`'s own doc comment for the resolution algorithm. */
  async findEffectiveRules(tenantId: string, jurisdiction: string): Promise<ComplianceRule[]> {
    const rules = await this.listRules(tenantId, jurisdiction);
    return resolveEffectiveRules(rules, new Date());
  }

  /**
   * §3.3's `ComplianceRuleService.GetActiveRule` - the single-rule lookup
   * Module 04's `PolicyService.GetActivePolicy` merge logic (§0.6) and this
   * module's own REST effective-rules endpoint both ultimately reduce to.
   * Reuses `resolveEffectiveRules` (filtered to one `ruleType` first, so at
   * most one row survives) rather than a separate implementation - the
   * "one canonical rule representation" instruction (§3.2) applied to this
   * gRPC path too, not just the REST one.
   */
  async getActiveRule(
    tenantId: string,
    jurisdiction: string,
    ruleType: ComplianceRuleType,
    asOf: Date,
  ): Promise<ComplianceRule | null> {
    const rules = await this.listRules(tenantId, jurisdiction);
    const resolved = resolveEffectiveRules(
      rules.filter((rule) => rule.ruleType === ruleType),
      asOf,
    );
    return resolved[0] ?? null;
  }

  private async nextVersion(
    manager: EntityManager,
    tenantId: string,
    jurisdiction: string,
    ruleType: ComplianceRuleType,
  ): Promise<number> {
    const result = await manager.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM compliance.compliance_rule
       WHERE tenant_id = $1 AND jurisdiction = $2 AND rule_type = $3`,
      [tenantId, jurisdiction, ruleType],
    );
    return Number(result[0].next_version);
  }
}

/**
 * TypeORM's `QueryDeepPartialEntity` mapped type doesn't cleanly accept a
 * plain `Record<string, unknown>` value for a jsonb column typed the same
 * way - a known TypeORM typing limitation (same fix attendance-leave-service's
 * `LeaveRequestService` uses for `conflictFlags`), not a real type mismatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: Record<string, unknown>): any {
  return value;
}
