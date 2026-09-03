import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SchedulingGrpcClientService } from '../grpc/scheduling-grpc-client.service';
import { TenantScopeAssertionService } from './tenant-scope-assertion.service';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { SchedulingWritebackClientService } from './scheduling-writeback-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import { ScheduleJobNotFoundError } from './errors/schedule-job-not-found.error';
import {
  PROMPT_TEMPLATE_VERSION,
  SCHEDULE_EXPLANATION_SYSTEM_PROMPT,
  buildScheduleExplanationUserContent,
} from './schedule-explanation-prompt';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

/**
 * §6.2's internal contract, end to end, for one interaction type
 * (`explainSchedule`) - Phase 2's own scope ("get the gRPC-retrieve ->
 * LLM-translate -> store pattern correct for one module before
 * generalizing"). Steps map directly onto §6.2's numbered list:
 *
 * 1-2. (the GraphQL resolver already resolved "Module 04 owns this")
 * 3. `SchedulingGrpcClientService.getScheduleJobForExplanation` - the
 *    validated tenant scope travels as an explicit request field (§5.1).
 * 4. `TenantScopeAssertionService.assertSameTenant` - the explicit
 *    assertion step, before step 5 ever runs.
 * 5. `LlmClient.complete` with the fixed system prompt (§5.2).
 * 6. `AIInteraction` persisted with `input_context` set to exactly what
 *    step 5 was given.
 * 7. Write back to Module 04 (`SchedulingWritebackClientService`) + audit
 *    (`AuditGrpcClientService`, §2.2 rule 3) - fire-and-forget, both
 *    best-effort per their own doc comments.
 *
 * §4's degraded-mode path is a minimal, real version of the full circuit
 * breaker Phase 7 builds: a single `LlmClient.complete` failure (any cause,
 * including "this tenant hasn't configured a BYOK provider yet" -
 * `AiProviderNotConfiguredError`, docs/adr/0117) falls back to returning
 * the raw structured data already retrieved in step 3, `degraded_mode =
 * true`, `output_text = null` - never a crash, never a fabricated
 * explanation, never nothing at all.
 */
@Injectable()
export class ScheduleExplanationService {
  private readonly logger = new Logger(ScheduleExplanationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly schedulingClient: SchedulingGrpcClientService,
    private readonly tenantScopeAssertion: TenantScopeAssertionService,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly writebackClient: SchedulingWritebackClientService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Phase 6 (docs/adr/0126): the gRPC-retrieve + §5.1 assertion + shaping
   * steps, pulled out once `AskQuestionService` became this method's
   * second real caller (the same "generalize once there's a second
   * caller" posture `parseLlmExplanationResponse` followed in Phase 4).
   * `explainSchedule` itself is now a thin wrapper: gather this context,
   * then run the shared LLM/persist/audit/write-back pipeline against it.
   */
  async gatherContext(tenantId: string, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.schedulingClient.getScheduleJobForExplanation(tenantId, jobId);
    if (!job.found) {
      throw new ScheduleJobNotFoundError(jobId);
    }

    // §5.1: defense in depth, independent of scheduling-service's own RLS
    // enforcement on the gRPC handler that produced this response.
    await this.tenantScopeAssertion.assertSameTenant(tenantId, [
      { sourceModule: 'scheduling', tenantId: job.tenantId },
    ]);

    return {
      jobId,
      status: job.status,
      orgUnitId: job.orgUnitId,
      dateRange: { start: job.dateRangeStart, end: job.dateRangeEnd },
      objectiveScore: job.objectiveScore === '' ? null : job.objectiveScore,
      constraintConfig: JSON.parse(job.constraintConfigJson || '{}'),
      relaxationsApplied: job.relaxationsAppliedJson ? JSON.parse(job.relaxationsAppliedJson) : null,
      decompositionPlan: job.decompositionPlanJson ? JSON.parse(job.decompositionPlanJson) : null,
      completedAt: job.completedAt === '' ? null : job.completedAt,
    };
  }

  async explainSchedule(tenantId: string, userId: string | null, jobId: string): Promise<AiInteraction> {
    const start = process.hrtime.bigint();

    const inputContext = await this.gatherContext(tenantId, jobId);

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: SCHEDULE_EXPLANATION_SYSTEM_PROMPT,
        userContent: buildScheduleExplanationUserContent(inputContext),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(parsed.selfReportedConfidence, parsed.summaryText, inputContext);
      modelUsed = `${provider.provider}:${completion.model}@${PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${PROMPT_TEMPLATE_VERSION}`;
      outputStructured = {
        topConstraints: (inputContext.relaxationsApplied as Record<string, unknown> | null) ?? {},
        tradeOffs: (inputContext.decompositionPlan as Record<string, unknown> | null) ?? {},
      };
      this.metrics.recordDegradedModeInteraction(AiInteractionType.SCHEDULE_EXPLANATION);
      this.logger.warn(`explainSchedule(${jobId}) served in degraded mode: ${err.message}`);
    }

    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = tenantId;
    interaction.userId = userId;
    interaction.interactionType = AiInteractionType.SCHEDULE_EXPLANATION;
    interaction.inputContext = inputContext;
    interaction.outputText = outputText;
    interaction.outputStructured = outputStructured;
    interaction.modelUsed = modelUsed;
    interaction.confidenceIndicator = confidenceIndicator === null ? null : confidenceIndicator.toFixed(2);
    interaction.degradedMode = degradedMode;
    interaction.createdAt = new Date();

    const saved = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(AiInteraction, interaction),
    );

    this.metrics.recordAiInteraction(tenantId, AiInteractionType.SCHEDULE_EXPLANATION);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.SCHEDULE_EXPLANATION,
      Number(process.hrtime.bigint() - start) / 1e9,
    );

    // §2.2 rule 3 - every AIInteraction feeds Module 01's AuditLog with
    // actor_type: ai_agent and ai_rationale populated. Fire-and-forget,
    // after the row that matters (AIInteraction) is already durably saved.
    await this.auditClient.recordEvent({
      tenantId,
      actorId: '',
      actorType: 'ai_agent',
      action: 'ai.schedule_explanation.generated',
      resourceType: 'schedule_job',
      resourceId: jobId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode }),
      aiRationaleJson: JSON.stringify({ modelUsed, confidenceIndicator, degradedMode }),
    });

    if (!degradedMode && outputText && outputStructured) {
      await this.writebackClient.submitScheduleExplanation(
        tenantId,
        jobId,
        outputText,
        outputStructured.topConstraints as Record<string, unknown>,
        outputStructured.tradeOffs as Record<string, unknown>,
      );
    }

    return saved;
  }
}
