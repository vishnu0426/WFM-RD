import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ScheduleExplanationService } from './schedule-explanation.service';
import { ForecastExplanationService } from './forecast-explanation.service';
import { ReallocationRationaleService } from './reallocation-rationale.service';
import { RootCauseAnalysisService } from './root-cause-analysis.service';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AskQuestionContextInvalidError } from './errors/ask-question-context-invalid.error';
import { AiAssistantUnavailableError } from './errors/ai-assistant-unavailable.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import { NL_QUERY_PROMPT_TEMPLATE_VERSION, NL_QUERY_SYSTEM_PROMPT, buildNlQueryUserContent } from './nl-query-prompt';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

/** Phase 9 (docs/adr/0133) - a real cost/DoS guardrail on `question`'s length, not just a formality; see `askQuestion`'s own check. */
const MAX_QUESTION_LENGTH = 4000;

/** §6.1's `askQuestion(context, question)` - exactly one field group must be set; see `AskQuestionService.resolveSource`. */
export interface AskQuestionContext {
  scheduleJobId?: string | null;
  forecastRunId?: string | null;
  reallocationActionId?: string | null;
  orgUnitId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

interface ResolvedAskQuestionSource {
  sourceType: 'schedule_job' | 'forecast_run' | 'reallocation_action' | 'org_unit';
  sourceId: string;
  groundingData: Record<string, unknown>;
}

/**
 * Phase 6 (docs/adr/0126/0127): §6.1's `askQuestion` - the one interaction
 * type §9 describes as a conversational/NL query rather than "explain this
 * one specific resource." ADR-0111 already disclosed, for Module 09, that
 * no capability exists anywhere in this platform to resolve a free-text
 * question into a specific resource id - that gap is not closed here
 * either. Per non-negotiable #2, the caller must instead supply an
 * unambiguous pointer to exactly one already-real resource, reusing the
 * same four `gatherContext` methods Phases 2/4 built (never a fifth
 * fetch-path, never a guess at "which resource is this question about").
 *
 * The human-in-the-loop guarantee §9 Phase 6 calls out is structural, not
 * an extra check added here: `AiRecommendationService.createFromInteraction`
 * only ever accepts an interaction whose `interactionType` is
 * `reallocation_rationale` (Phase 5, docs/adr/0123) - an `nl_query`-typed
 * interaction can never seed an `AIRecommendation`, so `askQuestion` cannot
 * auto-trigger an action even in principle. See
 * `ask-question.service.spec.ts`'s own explicit test of this.
 */
@Injectable()
export class AskQuestionService {
  private readonly logger = new Logger(AskQuestionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scheduleExplanation: ScheduleExplanationService,
    private readonly forecastExplanation: ForecastExplanationService,
    private readonly reallocationRationale: ReallocationRationaleService,
    private readonly rootCauseAnalysis: RootCauseAnalysisService,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  private async resolveSource(tenantId: string, context: AskQuestionContext): Promise<ResolvedAskQuestionSource> {
    const rootCauseFieldsPresent =
      context.orgUnitId != null || context.periodStart != null || context.periodEnd != null;
    const provided = [
      context.scheduleJobId != null,
      context.forecastRunId != null,
      context.reallocationActionId != null,
      rootCauseFieldsPresent,
    ].filter(Boolean).length;

    if (provided !== 1) {
      throw new AskQuestionContextInvalidError(
        `Exactly one of scheduleJobId, forecastRunId, reallocationActionId, or (orgUnitId + periodStart + periodEnd) must be provided (received ${provided} candidate source${provided === 1 ? '' : 's'}).`,
      );
    }

    if (context.scheduleJobId != null) {
      return {
        sourceType: 'schedule_job',
        sourceId: context.scheduleJobId,
        groundingData: await this.scheduleExplanation.gatherContext(tenantId, context.scheduleJobId),
      };
    }
    if (context.forecastRunId != null) {
      return {
        sourceType: 'forecast_run',
        sourceId: context.forecastRunId,
        groundingData: await this.forecastExplanation.gatherContext(tenantId, context.forecastRunId),
      };
    }
    if (context.reallocationActionId != null) {
      return {
        sourceType: 'reallocation_action',
        sourceId: context.reallocationActionId,
        groundingData: await this.reallocationRationale.gatherContext(tenantId, context.reallocationActionId),
      };
    }

    if (context.orgUnitId == null || context.periodStart == null || context.periodEnd == null) {
      throw new AskQuestionContextInvalidError('orgUnitId, periodStart, and periodEnd must all be provided together.');
    }
    return {
      sourceType: 'org_unit',
      sourceId: context.orgUnitId,
      groundingData: await this.rootCauseAnalysis.gatherContext(
        tenantId,
        context.orgUnitId,
        context.periodStart,
        context.periodEnd,
      ),
    };
  }

  async askQuestion(
    tenantId: string,
    userId: string | null,
    question: string,
    context: AskQuestionContext,
  ): Promise<AiInteraction> {
    const start = process.hrtime.bigint();

    // Phase 9 (docs/adr/0133): a real, narrow cost/DoS guardrail - nothing
    // upstream of this service bounds `question`'s length (a plain GraphQL
    // `String!` scalar), and every question triggers a real, billed LLM
    // call. Checked before `resolveSource` so an oversized question is
    // rejected without even the gRPC fan-out cost of resolving its source.
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new AskQuestionContextInvalidError(
        `question must be ${MAX_QUESTION_LENGTH} characters or fewer (received ${question.length}).`,
      );
    }

    const resolved = await this.resolveSource(tenantId, context);
    const inputContext = {
      question,
      sourceType: resolved.sourceType,
      sourceId: resolved.sourceId,
      groundingData: resolved.groundingData,
    };

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: NL_QUERY_SYSTEM_PROMPT,
        userContent: buildNlQueryUserContent(question, resolved.groundingData),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(
        parsed.selfReportedConfidence,
        parsed.summaryText,
        resolved.groundingData,
      );
      modelUsed = `${provider.provider}:${completion.model}@${NL_QUERY_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      // §4, adapted for `askQuestion`: unlike every other interaction type,
      // an NL answer has no non-LLM equivalent to fall back to - the row
      // below is still persisted (the attempt happened, same audit/
      // reproducibility invariant every other path keeps), but the caller
      // gets an explicit unavailability error, thrown after persistence,
      // instead of a fabricated or silently empty "successful" response.
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${NL_QUERY_PROMPT_TEMPLATE_VERSION}`;
      this.metrics.recordDegradedModeInteraction(AiInteractionType.NL_QUERY);
      this.logger.warn(
        `askQuestion(${resolved.sourceType}:${resolved.sourceId}) served in degraded mode: ${err.message}`,
      );
    }

    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = tenantId;
    interaction.userId = userId;
    interaction.interactionType = AiInteractionType.NL_QUERY;
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

    this.metrics.recordAiInteraction(tenantId, AiInteractionType.NL_QUERY);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.NL_QUERY,
      Number(process.hrtime.bigint() - start) / 1e9,
    );

    await this.auditClient.recordEvent({
      tenantId,
      actorId: '',
      actorType: 'ai_agent',
      action: 'ai.nl_query.answered',
      resourceType: resolved.sourceType,
      resourceId: resolved.sourceId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode }),
      aiRationaleJson: JSON.stringify({ modelUsed, confidenceIndicator, degradedMode }),
    });

    if (degradedMode) {
      throw new AiAssistantUnavailableError();
    }

    return saved;
  }
}
