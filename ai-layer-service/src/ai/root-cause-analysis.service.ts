import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ComplianceGrpcClientService } from '../grpc/compliance-grpc-client.service';
import { IntradayGrpcClientService } from '../grpc/intraday-grpc-client.service';
import { TenantScopeAssertionService, TenantScopedFact } from './tenant-scope-assertion.service';
import { LlmClient } from './llm/llm-client';
import { LlmCallFailedError } from './llm/llm-call-failed.error';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';
import { RootCauseAnalysisNoDataError } from './errors/root-cause-analysis-no-data.error';
import {
  ROOT_CAUSE_ANALYSIS_PROMPT_TEMPLATE_VERSION,
  ROOT_CAUSE_ANALYSIS_SYSTEM_PROMPT,
  buildRootCauseAnalysisUserContent,
} from './root-cause-analysis-prompt';
import { parseLlmExplanationResponse } from './parse-llm-explanation-response';
import { computeConfidenceIndicator } from './confidence-indicator';

/**
 * Phase 4 (docs/adr/0122): `root_cause_analysis` - the first interaction
 * type that assembles `input_context` from more than one owning module in
 * a single call (Module 08's adherence rollup + Module 05's reallocation-
 * churn list, both keyed by org_unit_id + period), exercising
 * `TenantScopeAssertionService.assertSameTenant`'s multi-fact array for
 * real (Phase 3's own test coverage proved the logic; this is the first
 * real caller).
 *
 * Deliberately scoped to two sources, not three: a natural extension would
 * add Module 03's forecast accuracy for the same org unit/period, but no
 * gRPC contract exists to look up a forecast run BY org_unit+period
 * (`ForecastExplanationDataService.GetForecastRunForExplanation` is keyed
 * by forecast_run_id, per ADR-0119) - adding one was out of this phase's
 * own scope, not silently worked around.
 *
 * Neither data source missing/empty is itself an error - a quiet period
 * with zero reallocations, or an org unit with no adherence rows yet, are
 * both legitimate outcomes (§4's "not found" isn't always bad news).
 * `RootCauseAnalysisNoDataError` only fires when BOTH sources have nothing
 * at all - grounding non-negotiable #2 at the point where there would
 * otherwise be nothing real to hand the LLM.
 */
@Injectable()
export class RootCauseAnalysisService {
  private readonly logger = new Logger(RootCauseAnalysisService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly complianceClient: ComplianceGrpcClientService,
    private readonly intradayClient: IntradayGrpcClientService,
    private readonly tenantScopeAssertion: TenantScopeAssertionService,
    private readonly llmClient: LlmClient,
    private readonly aiProviderConfig: AiProviderConfigService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  /** Phase 6 (docs/adr/0126) - own copy of `ScheduleExplanationService.gatherContext`'s own doc comment. */
  async gatherContext(
    tenantId: string,
    orgUnitId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Record<string, unknown>> {
    const periodStartIso = periodStart.toISOString();
    const periodEndIso = periodEnd.toISOString();

    const [adherence, reallocations] = await Promise.all([
      this.complianceClient.getOrgUnitAdherenceSummary(tenantId, orgUnitId, periodStartIso, periodEndIso),
      this.intradayClient.listReallocationsForPeriod(tenantId, periodStartIso, periodEndIso),
    ]);

    if (!adherence.found && reallocations.reallocations.length === 0 && reallocations.totalMatchedBeforeCap === 0) {
      throw new RootCauseAnalysisNoDataError(orgUnitId);
    }

    // §5.1: only assert facts that are actually present - AdherenceRollupService's
    // own `found: false` sentinel carries an empty tenant_id, which is not
    // a real fact to compare (it would always, incorrectly, "mismatch").
    // The reallocation list has no per-row tenant_id to assert against - it
    // is already constrained by an explicit tenant_id WHERE clause plus RLS
    // at the source, unlike a single-row lookup with something to echo.
    const facts: TenantScopedFact[] = adherence.found
      ? [{ sourceModule: 'compliance', tenantId: adherence.tenantId }]
      : [];
    await this.tenantScopeAssertion.assertSameTenant(tenantId, facts);

    return {
      orgUnitId,
      period: { start: periodStartIso, end: periodEndIso },
      adherence: adherence.found
        ? {
            employeeCount: adherence.employeeCount,
            scoredEmployeeCount: adherence.scoredEmployeeCount,
            periodCount: adherence.periodCount,
            averageAdherencePct: adherence.averageAdherencePct,
            totalMajorDeviationCount: adherence.totalMajorDeviationCount,
            minAdherencePct: adherence.minAdherencePct,
            maxAdherencePct: adherence.maxAdherencePct,
          }
        : null,
      reallocations: {
        count: reallocations.reallocations.length,
        totalMatchedBeforeCap: reallocations.totalMatchedBeforeCap,
        items: reallocations.reallocations,
      },
    };
  }

  async analyzeRootCause(
    tenantId: string,
    userId: string | null,
    orgUnitId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<AiInteraction> {
    const start = process.hrtime.bigint();

    const inputContext = await this.gatherContext(tenantId, orgUnitId, periodStart, periodEnd);

    let outputText: string | null = null;
    let outputStructured: Record<string, unknown> | null = null;
    let confidenceIndicator: number | null = null;
    let modelUsed: string;
    let degradedMode = false;

    try {
      const provider = await this.aiProviderConfig.resolveForCall(tenantId);
      const completion = await this.llmClient.complete(provider, {
        systemPrompt: ROOT_CAUSE_ANALYSIS_SYSTEM_PROMPT,
        userContent: buildRootCauseAnalysisUserContent(inputContext),
      });
      const parsed = parseLlmExplanationResponse(completion.text);
      outputText = parsed.summaryText;
      outputStructured = { topConstraints: parsed.topConstraints, tradeOffs: parsed.tradeOffs };
      confidenceIndicator = computeConfidenceIndicator(parsed.selfReportedConfidence, parsed.summaryText, inputContext);
      modelUsed = `${provider.provider}:${completion.model}@${ROOT_CAUSE_ANALYSIS_PROMPT_TEMPLATE_VERSION}`;
    } catch (err) {
      if (!(err instanceof LlmCallFailedError) && !(err instanceof AiProviderNotConfiguredError)) {
        throw err;
      }
      degradedMode = true;
      modelUsed = `none (degraded_mode)@${ROOT_CAUSE_ANALYSIS_PROMPT_TEMPLATE_VERSION}`;
      outputStructured = {
        topConstraints: (inputContext.adherence as Record<string, unknown> | null) ?? {},
        tradeOffs: inputContext.reallocations as Record<string, unknown>,
      };
      this.metrics.recordDegradedModeInteraction(AiInteractionType.ROOT_CAUSE_ANALYSIS);
      this.logger.warn(`analyzeRootCause(${orgUnitId}) served in degraded mode: ${err.message}`);
    }

    const interaction = new AiInteraction();
    interaction.id = randomUUID();
    interaction.tenantId = tenantId;
    interaction.userId = userId;
    interaction.interactionType = AiInteractionType.ROOT_CAUSE_ANALYSIS;
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

    this.metrics.recordAiInteraction(tenantId, AiInteractionType.ROOT_CAUSE_ANALYSIS);
    this.metrics.observeAiInteractionDuration(
      AiInteractionType.ROOT_CAUSE_ANALYSIS,
      Number(process.hrtime.bigint() - start) / 1e9,
    );

    await this.auditClient.recordEvent({
      tenantId,
      actorId: '',
      actorType: 'ai_agent',
      action: 'ai.root_cause_analysis.generated',
      resourceType: 'org_unit',
      resourceId: orgUnitId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ aiInteractionId: saved.id, degradedMode }),
      aiRationaleJson: JSON.stringify({ modelUsed, confidenceIndicator, degradedMode }),
    });

    return saved;
  }
}
