import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ForecastingGrpcClientService } from '../grpc/forecasting-grpc-client.service';
import { TenantScopeAssertionService } from './tenant-scope-assertion.service';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import { ForecastRunNotFoundError } from './errors/forecast-run-not-found.error';
import {
  FORECAST_EXPLANATION_PROMPT_TEMPLATE_VERSION,
  FORECAST_EXPLANATION_SYSTEM_PROMPT,
  buildForecastExplanationUserContent,
} from './forecast-explanation-prompt';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

/**
 * Phase 4 (docs/adr/0119): own copy of `ScheduleExplanationService`'s
 * pipeline shape, for `explainForecast(forecastRunId)` against Module 03
 * instead of Module 04 - proof that Phase 2's pattern (gRPC-retrieve -> §5.1
 * assertion -> BYOK provider resolve -> LLM call -> persist -> audit)
 * generalizes to a second owning module without inventing anything new.
 * No write-back call here (unlike scheduling's `POST .../explanation`) -
 * forecasting-service has no analogous "submit an explanation" endpoint,
 * and none was asked for; `explainForecast` is read-only from Module 03's
 * perspective.
 */
@Injectable()
export class ForecastExplanationService {
  private readonly logger = new Logger(ForecastExplanationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly forecastingClient: ForecastingGrpcClientService,
    private readonly tenantScopeAssertion: TenantScopeAssertionService,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  /** Phase 6 (docs/adr/0126) - own copy of `ScheduleExplanationService.gatherContext`'s own doc comment. */
  async gatherContext(tenantId: string, forecastRunId: string): Promise<Record<string, unknown>> {
    const run = await this.forecastingClient.getForecastRunForExplanation(tenantId, forecastRunId);
    if (!run.found) {
      throw new ForecastRunNotFoundError(forecastRunId);
    }

    await this.tenantScopeAssertion.assertSameTenant(tenantId, [
      { sourceModule: 'forecasting', tenantId: run.tenantId },
    ]);

    return {
      forecastRunId,
      orgUnitId: run.orgUnitId,
      status: run.status,
      dateRange: { start: run.dateRangeStart, end: run.dateRangeEnd },
      intervalMinutes: run.intervalMinutes,
      isColdStart: run.isColdStart,
      completedAt: run.completedAt === '' ? null : run.completedAt,
      model: run.hasModel
        ? {
            type: run.modelType,
            status: run.modelStatus,
            backtestMape: run.backtestMape === '' ? null : run.backtestMape,
            backtestWfa: run.backtestWfa === '' ? null : run.backtestWfa,
            minimumDataVolumeMet: run.minimumDataVolumeMet,
          }
        : null,
      // Proto3's repeated fields don't round-trip a genuinely-empty list as
      // `[]` through this gRPC-JS client the way scalar zero-values are
      // already normalized elsewhere in this method (`completedAt === ''`)
      // - a forecast run with zero accuracy log entries comes back with
      // `accuracyLog: undefined`, not `[]`.
      accuracyLog: (run.accuracyLog ?? []).map((entry) => ({
        evaluatedAt: entry.evaluatedAt,
        actualVolume: entry.actualVolume,
        predictedVolume: entry.predictedVolume,
        mape: entry.mape === '' ? null : entry.mape,
        bias: entry.bias === '' ? null : entry.bias,
      })),
    };
  }

  async explainForecast(tenantId: string, userId: string | null, forecastRunId: string): Promise<AiInteraction> {
    const start = process.hrtime.bigint();

    const inputContext = await this.gatherContext(tenantId, forecastRunId);

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: FORECAST_EXPLANATION_SYSTEM_PROMPT,
        userContent: buildForecastExplanationUserContent(inputContext),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(parsed.selfReportedConfidence, parsed.summaryText, inputContext);
      modelUsed = `${provider.provider}:${completion.model}@${FORECAST_EXPLANATION_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${FORECAST_EXPLANATION_PROMPT_TEMPLATE_VERSION}`;
      outputStructured = {
        topConstraints: (inputContext.model as Record<string, unknown> | null) ?? {},
        tradeOffs: { accuracyLog: inputContext.accuracyLog },
      };
      this.metrics.recordDegradedModeInteraction(AiInteractionType.FORECAST_EXPLANATION);
      this.logger.warn(`explainForecast(${forecastRunId}) served in degraded mode: ${err.message}`);
    }

    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = tenantId;
    interaction.userId = userId;
    interaction.interactionType = AiInteractionType.FORECAST_EXPLANATION;
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

    this.metrics.recordAiInteraction(tenantId, AiInteractionType.FORECAST_EXPLANATION);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.FORECAST_EXPLANATION,
      Number(process.hrtime.bigint() - start) / 1e9,
    );

    await this.auditClient.recordEvent({
      tenantId,
      actorId: '',
      actorType: 'ai_agent',
      action: 'ai.forecast_explanation.generated',
      resourceType: 'forecast_run',
      resourceId: forecastRunId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode }),
      aiRationaleJson: JSON.stringify({ modelUsed, confidenceIndicator, degradedMode }),
    });

    return saved;
  }
}
