import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IntradayGrpcClientService } from '../grpc/intraday-grpc-client.service';
import { TenantScopeAssertionService } from './tenant-scope-assertion.service';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import { ReallocationNotFoundError } from './errors/reallocation-not-found.error';
import {
  REALLOCATION_RATIONALE_PROMPT_TEMPLATE_VERSION,
  REALLOCATION_RATIONALE_SYSTEM_PROMPT,
  buildReallocationRationaleUserContent,
} from './reallocation-rationale-prompt';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

/**
 * Phase 4 (docs/adr/0120): own copy of `ScheduleExplanationService`'s
 * pipeline shape, for `explainReallocation(reallocationActionId)` against
 * Module 05. This is the first interaction type whose retrieved data
 * includes a genuinely tenant-user-authored free-text field
 * (`ReallocationAction.reason`, entered by a supervisor for a
 * `supervisor_manual` reallocation) - §5.2's "treat tenant-authored
 * free-text sub-fields with the same untrusted-content handling as direct
 * user input" is exercised for real here for the first time, not just
 * designed on paper (Phase 2's own readiness checklist flagged this as
 * deferred until a real interaction type needed it). The system prompt
 * (`reallocation-rationale-prompt.ts`) explicitly calls out `reason` as
 * data-to-describe, never an instruction, and it still only ever reaches
 * the model inside the untrusted user-content block, never concatenated
 * into the system string.
 */
@Injectable()
export class ReallocationRationaleService {
  private readonly logger = new Logger(ReallocationRationaleService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly intradayClient: IntradayGrpcClientService,
    private readonly tenantScopeAssertion: TenantScopeAssertionService,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  /** Phase 6 (docs/adr/0126) - own copy of `ScheduleExplanationService.gatherContext`'s own doc comment. */
  async gatherContext(tenantId: string, reallocationActionId: string): Promise<Record<string, unknown>> {
    const action = await this.intradayClient.getReallocationForExplanation(tenantId, reallocationActionId);
    if (!action.found) {
      throw new ReallocationNotFoundError(reallocationActionId);
    }

    await this.tenantScopeAssertion.assertSameTenant(tenantId, [
      { sourceModule: 'intraday', tenantId: action.tenantId },
    ]);

    return {
      reallocationActionId,
      triggeredBy: action.triggeredBy,
      fromQueueId: action.fromQueueId,
      toQueueId: action.toQueueId,
      affectedEmployeeIds: action.affectedEmployeeIds,
      // Human-authored free text (§5.2) - included as data for the model
      // to describe, never treated specially here either; the system
      // prompt is what actually prevents it being read as instructions.
      reason: action.reason,
      status: action.status,
      aiRationale: action.aiRationaleJson ? JSON.parse(action.aiRationaleJson) : null,
      createdAt: action.createdAt,
      executedAt: action.executedAt === '' ? null : action.executedAt,
    };
  }

  async explainReallocation(
    tenantId: string,
    userId: string | null,
    reallocationActionId: string,
  ): Promise<AiInteraction> {
    const start = process.hrtime.bigint();

    const inputContext = await this.gatherContext(tenantId, reallocationActionId);

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: REALLOCATION_RATIONALE_SYSTEM_PROMPT,
        userContent: buildReallocationRationaleUserContent(inputContext),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(parsed.selfReportedConfidence, parsed.summaryText, inputContext);
      modelUsed = `${provider.provider}:${completion.model}@${REALLOCATION_RATIONALE_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${REALLOCATION_RATIONALE_PROMPT_TEMPLATE_VERSION}`;
      outputStructured = {
        topConstraints: (inputContext.aiRationale as Record<string, unknown> | null) ?? {},
        tradeOffs: {},
      };
      this.metrics.recordDegradedModeInteraction(AiInteractionType.REALLOCATION_RATIONALE);
      this.logger.warn(`explainReallocation(${reallocationActionId}) served in degraded mode: ${err.message}`);
    }

    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = tenantId;
    interaction.userId = userId;
    interaction.interactionType = AiInteractionType.REALLOCATION_RATIONALE;
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

    this.metrics.recordAiInteraction(tenantId, AiInteractionType.REALLOCATION_RATIONALE);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.REALLOCATION_RATIONALE,
      Number(process.hrtime.bigint() - start) / 1e9,
    );

    await this.auditClient.recordEvent({
      tenantId,
      actorId: '',
      actorType: 'ai_agent',
      action: 'ai.reallocation_rationale.generated',
      resourceType: 'reallocation_action',
      resourceId: reallocationActionId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode }),
      aiRationaleJson: JSON.stringify({ modelUsed, confidenceIndicator, degradedMode }),
    });

    return saved;
  }
}
