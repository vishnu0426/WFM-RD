import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import {
  AiRecommendation,
  AiRecommendationSourceModule,
  AiRecommendationStatus,
} from './entities/ai-recommendation.entity';
import { AiAutonomyLevel } from './entities/ai-governance-policy.entity';
import { AiGovernancePolicyResolverService } from './ai-governance-policy-resolver.service';
import { RiskThresholdEvaluatorService } from './risk-threshold-evaluator.service';
import { ReallocationExecutionClientService } from './reallocation-execution-client.service';
import { AiRecommendationEventPublisherService } from './ai-recommendation-event-publisher.service';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { AiInteractionNotFoundError } from './errors/ai-interaction-not-found.error';
import { AiInteractionDegradedError } from './errors/ai-interaction-degraded.error';
import { AiInteractionNotRecommendableError } from './errors/ai-interaction-not-recommendable.error';
import { AiRecommendationNotFoundError } from './errors/ai-recommendation-not-found.error';
import { AiRecommendationNotDecidableError } from './errors/ai-recommendation-not-decidable.error';
import { detectSuspiciousRationalePhrases } from './rationale-suspicion-detector';

export type RecommendationDecision = 'approved' | 'rejected';

/**
 * Phase 5 (docs/adr/0123/0124): §3's governance resolution + §2's
 * `AIRecommendation` lifecycle + non-negotiable #1's write-back-through-
 * owning-module execution pathway, made concrete for one real source:
 * `reallocation_rationale` interactions (Module 05's `ReallocationAction`,
 * the only recommendation source this module has a real execution client
 * for - `scheduling`/`forecasting` recommendations can exist as data but
 * have no execute step wired yet, see `UnsupportedRecommendationSourceError`).
 *
 * `suggest_only` and `approve_required` both resolve
 * `requires_human_approval: true` - the difference only matters at
 * decision time: `approve_required`'s `decideRecommendation('approved')`
 * calls the owning module's write API for real; `suggest_only`'s does not
 * - it is purely advisory record-keeping, and any actual action has to
 * happen through the owning module's own normal UI/API, outside this
 * pathway entirely. This is the more conservative reading of "suggest
 * only" (§3) - the AI never gets to close the loop for this action_type,
 * not even with a human's nod - and is why `resolved_autonomy_level` is
 * stored in full (docs/adr/0123), not just the derived boolean.
 */
@Injectable()
export class AiRecommendationService {
  private readonly logger = new Logger(AiRecommendationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly governanceResolver: AiGovernancePolicyResolverService,
    private readonly riskEvaluator: RiskThresholdEvaluatorService,
    private readonly reallocationExecutionClient: ReallocationExecutionClientService,
    private readonly eventPublisher: AiRecommendationEventPublisherService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  /** §6.1's `pendingRecommendations(orgUnitId)` - `orgUnitId` optional, matching intraday-service's own `pendingReallocations` precedent. A recommendation with `org_unit_id: NULL` (every reallocation-sourced one today, ADR-0122) never matches an org-unit-scoped call - an honest gap, not a bug, disclosed in docs/adr/0123. */
  async listPending(tenantId: string, orgUnitId?: string): Promise<AiRecommendation[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .getRepository(AiRecommendation)
        .createQueryBuilder('r')
        .where('r.tenant_id = :tenantId', { tenantId })
        .andWhere('r.status = :status', { status: AiRecommendationStatus.SUGGESTED })
        .orderBy('r.created_at', 'DESC');
      if (orgUnitId) {
        qb.andWhere('r.org_unit_id = :orgUnitId', { orgUnitId });
      }
      return qb.getMany();
    });
  }

  /** `aiRecommendations(status, orgUnitId, sourceModule, limit, offset)` - `listPending`'s general-purpose sibling: no hardcoded `status = SUGGESTED` filter, paginated, for an admin history view rather than a supervisor's live queue. */
  async list(
    tenantId: string,
    filter: {
      status?: AiRecommendationStatus;
      orgUnitId?: string;
      sourceModule?: AiRecommendationSourceModule;
      limit?: number;
      offset?: number;
    },
  ): Promise<AiRecommendation[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .getRepository(AiRecommendation)
        .createQueryBuilder('r')
        .where('r.tenant_id = :tenantId', { tenantId })
        .orderBy('r.created_at', 'DESC')
        .take(filter.limit ?? 50)
        .skip(filter.offset ?? 0);
      if (filter.status) {
        qb.andWhere('r.status = :status', { status: filter.status });
      }
      if (filter.orgUnitId) {
        qb.andWhere('r.org_unit_id = :orgUnitId', { orgUnitId: filter.orgUnitId });
      }
      if (filter.sourceModule) {
        qb.andWhere('r.source_module = :sourceModule', { sourceModule: filter.sourceModule });
      }
      return qb.getMany();
    });
  }

  async createFromInteraction(tenantId: string, aiInteractionId: string): Promise<AiRecommendation> {
    const interaction = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AiInteraction, { where: { id: aiInteractionId, tenantId } }),
    );
    if (!interaction) {
      throw new AiInteractionNotFoundError(aiInteractionId);
    }
    if (interaction.interactionType !== AiInteractionType.REALLOCATION_RATIONALE) {
      throw new AiInteractionNotRecommendableError(interaction.interactionType);
    }
    if (interaction.degradedMode || !interaction.outputText) {
      throw new AiInteractionDegradedError(aiInteractionId);
    }

    const recommendationType = 'reallocation';
    const context = interaction.inputContext as Record<string, unknown>;
    const affectedEmployeeCount = Array.isArray(context.affectedEmployeeIds)
      ? (context.affectedEmployeeIds as unknown[]).length
      : 0;

    const governance = await this.governanceResolver.resolve(tenantId, recommendationType);
    let requiresHumanApproval = governance.autonomyLevel !== AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK;

    if (governance.autonomyLevel === AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK) {
      const evaluation = this.riskEvaluator.evaluate(governance.riskThresholdConfig, {
        affectedEmployeeCount,
        confidenceIndicator: interaction.confidenceIndicator === null ? null : Number(interaction.confidenceIndicator),
      });
      if (!evaluation.passed) {
        // §3: "a recommendation failing any threshold check falls back to
        // approve_required regardless of the configured autonomy level."
        requiresHumanApproval = true;
        this.logger.log(
          `auto_execute_low_risk fell back to approve_required for interaction ${aiInteractionId}: ${evaluation.failedCriteria.join('; ')}`,
        );
      }
    }

    // Phase 9 (docs/adr/0131/0133): a heuristic, disclosed-as-incomplete
    // signal, treated as its own failed risk-threshold criterion - any
    // flagged phrase forces human approval, regardless of autonomy level.
    // Never used to clear an already-required approval; only ever tightens.
    const suspiciousLanguageFlags = detectSuspiciousRationalePhrases(interaction.outputText);
    if (suspiciousLanguageFlags.length > 0 && !requiresHumanApproval) {
      requiresHumanApproval = true;
      this.logger.warn(
        `auto_execute_low_risk fell back to approve_required for interaction ${aiInteractionId}: rationale flagged suspicious language (${suspiciousLanguageFlags.join(', ')})`,
      );
    }

    const recommendation = new AiRecommendation();
    recommendation.id = randomUUID();
    recommendation.tenantId = tenantId;
    // ReallocationAction has no org_unit_id column (ADR-0122's own
    // disclosed limitation) - honest null, never guessed.
    recommendation.orgUnitId = null;
    recommendation.recommendationType = recommendationType;
    recommendation.sourceModule = AiRecommendationSourceModule.INTRADAY;
    recommendation.rationaleText = interaction.outputText;
    recommendation.supportingDataJson = context;
    recommendation.status = AiRecommendationStatus.SUGGESTED;
    recommendation.requiresHumanApproval = requiresHumanApproval;
    recommendation.suspiciousLanguageFlags = suspiciousLanguageFlags;
    recommendation.resolvedAutonomyLevel = governance.autonomyLevel;
    recommendation.decidedBy = null;
    recommendation.decidedAt = null;
    recommendation.aiInteractionId = aiInteractionId;
    recommendation.createdAt = new Date();

    let saved = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(AiRecommendation, recommendation),
    );

    this.metrics.recordAiRecommendation(tenantId, governance.autonomyLevel);
    await this.recordAudit(tenantId, saved, 'ai.recommendation.created');
    await this.eventPublisher.publishCreated(saved);

    if (!requiresHumanApproval) {
      const reallocationActionId = context.reallocationActionId as string;
      saved = await this.execute(tenantId, saved, reallocationActionId, null, AiRecommendationStatus.AUTO_EXECUTED);
    }

    return saved;
  }

  async decideRecommendation(
    tenantId: string,
    userId: string | null,
    recommendationId: string,
    decision: RecommendationDecision,
  ): Promise<AiRecommendation> {
    const recommendation = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AiRecommendation, { where: { id: recommendationId, tenantId } }),
    );
    if (!recommendation) {
      throw new AiRecommendationNotFoundError(recommendationId);
    }
    if (recommendation.status !== AiRecommendationStatus.SUGGESTED) {
      throw new AiRecommendationNotDecidableError(recommendationId, recommendation.status);
    }

    if (decision === 'rejected') {
      recommendation.status = AiRecommendationStatus.REJECTED;
      recommendation.decidedBy = userId;
      recommendation.decidedAt = new Date();
      const saved = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.save(AiRecommendation, recommendation),
      );
      await this.recordAudit(tenantId, saved, 'ai.recommendation.decided');
      await this.eventPublisher.publishDecided(saved);
      return saved;
    }

    // approved
    if (recommendation.resolvedAutonomyLevel === AiAutonomyLevel.SUGGEST_ONLY) {
      // Purely advisory - record the decision, never execute (see this
      // class's own doc comment for why `suggest_only` never closes the loop).
      recommendation.status = AiRecommendationStatus.APPROVED;
      recommendation.decidedBy = userId;
      recommendation.decidedAt = new Date();
      const saved = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.save(AiRecommendation, recommendation),
      );
      await this.recordAudit(tenantId, saved, 'ai.recommendation.decided');
      await this.eventPublisher.publishDecided(saved);
      return saved;
    }

    const reallocationActionId = (recommendation.supportingDataJson as Record<string, unknown>)
      .reallocationActionId as string;
    recommendation.decidedBy = userId;
    return this.execute(tenantId, recommendation, reallocationActionId, userId, AiRecommendationStatus.APPROVED);
  }

  /** The write-back-through-owning-module pathway (non-negotiable #1) - the LLM/this module never writes to `intraday.reallocation_action` itself. */
  private async execute(
    tenantId: string,
    recommendation: AiRecommendation,
    reallocationActionId: string,
    decidedBy: string | null,
    finalStatus: AiRecommendationStatus,
  ): Promise<AiRecommendation> {
    if (recommendation.sourceModule !== AiRecommendationSourceModule.INTRADAY) {
      throw new Error(`No execution pathway wired for source_module "${recommendation.sourceModule}"`);
    }
    await this.reallocationExecutionClient.approveReallocation(tenantId, reallocationActionId);

    recommendation.status = finalStatus;
    recommendation.decidedBy = decidedBy;
    recommendation.decidedAt = new Date();
    const saved = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(AiRecommendation, recommendation),
    );
    await this.recordAudit(tenantId, saved, 'ai.recommendation.decided');
    await this.eventPublisher.publishDecided(saved);
    return saved;
  }

  private async recordAudit(tenantId: string, recommendation: AiRecommendation, action: string): Promise<void> {
    await this.auditClient.recordEvent({
      tenantId,
      actorId: recommendation.decidedBy ?? '',
      actorType: 'ai_agent',
      action,
      resourceType: 'ai_recommendation',
      resourceId: recommendation.id,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({
        status: recommendation.status,
        resolvedAutonomyLevel: recommendation.resolvedAutonomyLevel,
      }),
      aiRationaleJson: JSON.stringify({ rationaleText: recommendation.rationaleText }),
    });
  }
}
