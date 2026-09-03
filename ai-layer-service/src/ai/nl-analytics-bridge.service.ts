import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AnalyticsNlBridgeUnavailableError } from './errors/analytics-nl-bridge-unavailable.error';
import { AnalyticsNlBridgeRateLimitedError } from './errors/analytics-nl-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from './errors/analytics-question-too-long.error';
import { AiInteractionRateLimiterService } from '../auth/ai-interaction-rate-limiter.service';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import {
  NL_ANALYTICS_TRANSLATE_PROMPT_TEMPLATE_VERSION,
  NL_ANALYTICS_ANSWER_PROMPT_TEMPLATE_VERSION,
  NL_ANALYTICS_TRANSLATE_SYSTEM_PROMPT,
  NL_ANALYTICS_ANSWER_SYSTEM_PROMPT,
  buildNlAnalyticsTranslateUserContent,
  buildNlAnalyticsAnswerUserContent,
} from './nl-analytics-bridge-prompt';
import { parseNlAnalyticsTranslation, ParsedNlAnalyticsTranslation } from './parse-nl-analytics-translation';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

const MAX_QUESTION_LENGTH = 4000;

interface PersistArgs {
  tenantId: string;
  userId: string | null;
  step: 'translate_question' | 'generate_answer';
  inputContext: Record<string, unknown>;
  outputText: string | null;
  outputStructured: Record<string, unknown> | null;
  confidenceIndicator: number | null;
  modelUsed: string;
  degradedMode: boolean;
  startedAt: bigint;
  auditAction: string;
  auditResourceId: string;
}

/**
 * ADR-0165: Module 10's side of the `askAnalyticsQuestion` bridge -
 * `NlQueryBridgeGrpcController`'s two RPCs delegate straight here. Own copy
 * of `ForecastExplanationService`/`AskQuestionService`'s pipeline shape
 * (BYOK provider resolve -> LLM call -> parse -> persist `AiInteraction` ->
 * audit), minus the gRPC-fan-out "gather context" step neither method
 * needs - the caller (Module 09, over gRPC) already supplies everything
 * to ground the call (the metric catalog for translation, the real query
 * results for the answer).
 *
 * Like `AskQuestionService`, neither method has a non-LLM degraded-mode
 * fallback that could stand in as a real answer - a degraded attempt still
 * persists its `AiInteraction` row (`degradedMode: true`, `output_text:
 * null`), then throws `AnalyticsNlBridgeUnavailableError` rather than
 * returning a fabricated or empty "successful" result.
 */
@Injectable()
export class NlAnalyticsBridgeService {
  private readonly logger = new Logger(NlAnalyticsBridgeService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly rateLimiter: AiInteractionRateLimiterService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  async translateQuestion(
    tenantId: string,
    userId: string | null,
    question: string,
    availableMetricNames: string[],
  ): Promise<ParsedNlAnalyticsTranslation> {
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new AnalyticsQuestionTooLongError(question.length, MAX_QUESTION_LENGTH);
    }
    this.enforceRateLimit(tenantId, userId);

    const start = process.hrtime.bigint();
    const inputContext = { question, availableMetricNames };

    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;
    let translated: ParsedNlAnalyticsTranslation | null = null;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: NL_ANALYTICS_TRANSLATE_SYSTEM_PROMPT,
        userContent: buildNlAnalyticsTranslateUserContent(question, availableMetricNames),
      });
      translated = parseNlAnalyticsTranslation(completion.text, availableMetricNames);
      outputStructured = { ...translated };
      confidenceIndicator = computeConfidenceIndicator(
        translated.selfReportedConfidence,
        JSON.stringify(translated),
        inputContext,
      );
      modelUsed = `${provider.provider}:${completion.model}@${NL_ANALYTICS_TRANSLATE_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${NL_ANALYTICS_TRANSLATE_PROMPT_TEMPLATE_VERSION}`;
      this.metrics.recordDegradedModeInteraction(AiInteractionType.ANALYTICS_NL_BRIDGE);
      this.logger.warn(`translateQuestion(tenant=${tenantId}) served in degraded mode: ${err.message}`);
    }

    await this.persist({
      tenantId,
      userId,
      step: 'translate_question',
      inputContext,
      outputText: null,
      outputStructured,
      confidenceIndicator,
      modelUsed,
      degradedMode,
      startedAt: start,
      auditAction: 'ai.analytics_nl_bridge.translated',
      auditResourceId: tenantId,
    });

    if (degradedMode || !translated) {
      throw new AnalyticsNlBridgeUnavailableError();
    }
    return translated;
  }

  async generateAnswer(tenantId: string, userId: string | null, question: string, results: unknown): Promise<string> {
    this.enforceRateLimit(tenantId, userId);

    const start = process.hrtime.bigint();
    const inputContext = { question, results };

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: NL_ANALYTICS_ANSWER_SYSTEM_PROMPT,
        userContent: buildNlAnalyticsAnswerUserContent(question, results),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(parsed.selfReportedConfidence, parsed.summaryText, inputContext);
      modelUsed = `${provider.provider}:${completion.model}@${NL_ANALYTICS_ANSWER_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${NL_ANALYTICS_ANSWER_PROMPT_TEMPLATE_VERSION}`;
      this.metrics.recordDegradedModeInteraction(AiInteractionType.ANALYTICS_NL_BRIDGE);
      this.logger.warn(`generateAnswer(tenant=${tenantId}) served in degraded mode: ${err.message}`);
    }

    await this.persist({
      tenantId,
      userId,
      step: 'generate_answer',
      inputContext,
      outputText,
      outputStructured,
      confidenceIndicator,
      modelUsed,
      degradedMode,
      startedAt: start,
      auditAction: 'ai.analytics_nl_bridge.answered',
      auditResourceId: tenantId,
    });

    if (degradedMode || outputText === null) {
      throw new AnalyticsNlBridgeUnavailableError();
    }
    return outputText;
  }

  private enforceRateLimit(tenantId: string, userId: string | null): void {
    const decision = this.rateLimiter.tryAcquire(tenantId, userId ?? 'unknown');
    if (!decision.allowed) {
      throw new AnalyticsNlBridgeRateLimitedError(decision.retryAfterSeconds ?? 60);
    }
  }

  private async persist(args: PersistArgs): Promise<void> {
    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = args.tenantId;
    interaction.userId = args.userId;
    interaction.interactionType = AiInteractionType.ANALYTICS_NL_BRIDGE;
    interaction.inputContext = { step: args.step, ...args.inputContext };
    interaction.outputText = args.outputText;
    interaction.outputStructured = args.outputStructured;
    interaction.modelUsed = args.modelUsed;
    interaction.confidenceIndicator = args.confidenceIndicator === null ? null : args.confidenceIndicator.toFixed(2);
    interaction.degradedMode = args.degradedMode;
    interaction.createdAt = new Date();

    const saved = await withTenantConnection(this.dataSource, args.tenantId, (manager) =>
      manager.save(AiInteraction, interaction),
    );

    this.metrics.recordAiInteraction(args.tenantId, AiInteractionType.ANALYTICS_NL_BRIDGE);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.ANALYTICS_NL_BRIDGE,
      Number(process.hrtime.bigint() - args.startedAt) / 1e9,
    );

    await this.auditClient.recordEvent({
      tenantId: args.tenantId,
      actorId: args.userId ?? '',
      actorType: 'ai_agent',
      action: args.auditAction,
      resourceType: 'tenant',
      resourceId: args.auditResourceId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode: args.degradedMode }),
      aiRationaleJson: JSON.stringify({
        modelUsed: args.modelUsed,
        confidenceIndicator: args.confidenceIndicator,
        degradedMode: args.degradedMode,
      }),
    });
  }
}
