import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AiInteractionType {
  FORECAST_EXPLANATION = 'forecast_explanation',
  SCHEDULE_EXPLANATION = 'schedule_explanation',
  REALLOCATION_RATIONALE = 'reallocation_rationale',
  NL_QUERY = 'nl_query',
  ROOT_CAUSE_ANALYSIS = 'root_cause_analysis',
  // ADR-0165: Module 09's askAnalyticsQuestion bridge - one row per LLM
  // call (translateQuestion or generateAnswer), see migration
  // AiInteractionAnalyticsNlBridgeType's own doc comment.
  ANALYTICS_NL_BRIDGE = 'analytics_nl_bridge',
}

/**
 * §2.1's `AIInteraction` - the full audit/reproducibility record of one
 * query-router round trip. `inputContext` is a copy of the exact structured
 * data assembled from the owning module(s)' gRPC responses for THIS
 * interaction, never a live source anything else reads from (§2's own
 * framing) - non-negotiable #2 depends on this column actually holding what
 * was sent to the LLM, not a reconstruction after the fact.
 *
 * `confidenceIndicator`/`degradedMode` are nullable/false respectively
 * because `NotAvailableNlQueryBridgeClient`-style unavailable paths and
 * §4's degraded-mode fallback still write a real `AIInteraction` row (the
 * interaction happened, the model just didn't run) - `outputText: null`
 * plus `degradedMode: true` is that path's actual shape, not an absent row.
 */
@Entity({ name: 'ai_interaction', schema: 'ai_layer' })
export class AiInteraction {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Column('varchar', { name: 'interaction_type' })
  interactionType!: AiInteractionType;

  @Column('jsonb', { name: 'input_context' })
  inputContext!: Record<string, unknown>;

  @Column('text', { name: 'output_text', nullable: true })
  outputText!: string | null;

  @Column('jsonb', { name: 'output_structured', nullable: true })
  outputStructured!: Record<string, unknown> | null;

  // §0.5: "includes the prompt-template version alongside the model
  // identifier" - e.g. "claude-...@prompt-v3", never just the bare model id.
  @Column('varchar', { name: 'model_used' })
  modelUsed!: string;

  @Column('numeric', { name: 'confidence_indicator', precision: 3, scale: 2, nullable: true })
  confidenceIndicator!: string | null;

  @Column('boolean', { name: 'degraded_mode', default: false })
  degradedMode!: boolean;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
