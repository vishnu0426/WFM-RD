import { Field, Float, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SavedReport } from './entities/saved-report.entity';
import { DashboardWidget } from './entities/dashboard-widget.entity';
import { MetricDefinition, MetricCategory } from './entities/metric-definition.entity';
import { MetricResultData, ExecutiveSummaryPeriod } from './metric-query-engine.service';
import { CalculationDefinition } from './metric-validation.service';
import { AnalyticsAnswerData } from './ask-analytics-question.service';

registerEnumType(ExecutiveSummaryPeriod, {
  name: 'ExecutiveSummaryPeriod',
  description:
    "§4.1's executiveSummary(orgUnitId, period) - server-resolved into concrete date bounds, see metric-query-engine.service.ts's own resolvePeriodBounds.",
});

registerEnumType(MetricCategory, {
  name: 'MetricCategory',
  description:
    "§2.1's fixed metric-category vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

/**
 * §4.1's GraphQL types/inputs, one file per domain (own copy of
 * adherence-compliance-service's `types.ts` convention, ADR-0039) - not
 * split into per-type files. Mapper functions (`toDashboardResult`/
 * `toMetricResultType`) live alongside their types, same as that
 * convention's `toComplianceRuleResult`.
 */

@ObjectType('DashboardWidget')
export class DashboardWidgetResult {
  @Field(() => ID)
  id!: string;

  @Field()
  widgetType!: string;

  @Field(() => ID)
  metricId!: string;

  @Field(() => Object)
  position!: Record<string, unknown>;
}

@ObjectType('Dashboard')
export class DashboardResult {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => [DashboardWidgetResult])
  widgets!: DashboardWidgetResult[];

  /** ADR-0163: the owning user's id - the frontend compares this against its own verified `sub` to decide whether to offer Edit, never a server-trusted "isOwner" boolean computed against a header. */
  @Field(() => ID)
  createdBy!: string;

  /** ADR-0163: role names this dashboard is shared with, resolved against the viewer's *current* JWT `roles` claim on every access - see DashboardService's own doc comment. */
  @Field(() => [String!])
  sharedWith!: string[];
}

@ObjectType('MetricResult')
export class MetricResultType {
  @Field()
  metric!: string;

  @Field(() => Float, { nullable: true })
  value!: number | null;

  @Field(() => String, { nullable: true })
  trend!: 'up' | 'down' | 'flat' | null;

  @Field(() => Float, { nullable: true })
  comparisonPeriodValue!: number | null;

  @Field()
  periodStart!: Date;

  @Field()
  periodEnd!: Date;

  @Field(() => Date, { nullable: true })
  dataAsOf!: Date | null;
}

@InputType()
export class CreateDashboardWidgetInputType {
  @Field()
  @IsString()
  @IsIn(['kpi_tile', 'line_chart', 'bar_chart', 'table'])
  widgetType!: string;

  @Field(() => ID)
  @IsUUID()
  metricId!: string;

  @Field(() => Object)
  @IsObject()
  position!: Record<string, unknown>;
}

@InputType()
export class CreateDashboardInputType {
  @Field()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field(() => Object)
  @IsObject()
  config!: Record<string, unknown>;

  @Field(() => [CreateDashboardWidgetInputType])
  @ValidateNested({ each: true })
  @Type(() => CreateDashboardWidgetInputType)
  @ArrayMaxSize(50)
  widgets!: CreateDashboardWidgetInputType[];

  /** ADR-0163: role names to share this dashboard with, resolved live against each viewer's own JWT roles claim - see DashboardService's own doc comment. Omitted or `[]` = not shared. */
  @Field(() => [String!], { nullable: true })
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  sharedWithRoles?: string[];
}

@InputType()
export class MetricQueryFilterInputType {
  @Field(() => Date, { nullable: true })
  @IsOptional()
  periodStart?: Date;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  periodEnd?: Date;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  costCenter?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteOrgUnitId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsIn(['shift', 'day', 'week', 'month'])
  periodType?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@InputType()
export class CalculationDefinitionInputType {
  @Field()
  @IsString()
  @IsIn(['mv_adherence_trend_rollup', 'mv_forecast_accuracy_trend', 'mv_cost_vs_budget', 'mv_attrition_by_site'])
  sourceView!: string;

  @Field()
  @IsString()
  valueColumn!: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsString({ each: true })
  dimensions?: string[];
}

@InputType()
export class CreateMetricDefinitionInputType {
  @Field()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field(() => MetricCategory)
  @IsEnum(MetricCategory)
  category!: MetricCategory;

  @Field(() => CalculationDefinitionInputType)
  @ValidateNested()
  @Type(() => CalculationDefinitionInputType)
  calculationDefinition!: CalculationDefinitionInputType;
}

@ObjectType('MetricDefinition')
export class MetricDefinitionResult {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => MetricCategory)
  category!: MetricCategory;

  @Field(() => Object)
  calculationDefinition!: CalculationDefinition;

  @Field(() => Date, { nullable: true })
  validatedAt!: Date | null;

  @Field(() => String, { nullable: true })
  estimatedCostTier!: string | null;

  /** True for a platform-default row (`tenantId === null`) - same "expose a boolean, never the raw usually-null tenantId" convention adherence-compliance-service's `ComplianceRuleResult.isPlatformDefault` already established. */
  @Field(() => Boolean)
  isPlatformDefault!: boolean;
}

export function toMetricDefinitionResult(definition: MetricDefinition): MetricDefinitionResult {
  return {
    id: definition.id,
    name: definition.name,
    category: definition.category,
    calculationDefinition: definition.calculationDefinition as unknown as CalculationDefinition,
    validatedAt: definition.validatedAt,
    estimatedCostTier: definition.estimatedCostTier,
    isPlatformDefault: definition.tenantId === null,
  };
}

export function toDashboardResult(dashboard: SavedReport, widgets: DashboardWidget[]): DashboardResult {
  return {
    id: dashboard.id,
    name: dashboard.name,
    widgets: widgets.map((widget) => ({
      id: widget.id,
      widgetType: widget.widgetType,
      metricId: widget.metricId,
      position: widget.position,
    })),
    createdBy: dashboard.createdBy,
    sharedWith: dashboard.sharedWith as unknown as string[],
  };
}

export function toMetricResultType(result: MetricResultData): MetricResultType {
  return result;
}

/** Phase 7/ADR-0111: `askAnalyticsQuestion`'s return shape - `question` echoes the input, `results` are the same `MetricResult` shape `metricQuery` returns (never a third, ad-hoc results shape). */
@ObjectType('AnalyticsAnswer')
export class AnalyticsAnswerResult {
  @Field()
  question!: string;

  @Field()
  answerText!: string;

  @Field(() => [MetricResultType])
  results!: MetricResultType[];
}

export function toAnalyticsAnswerResult(answer: AnalyticsAnswerData): AnalyticsAnswerResult {
  return {
    question: answer.question,
    answerText: answer.answerText,
    results: answer.results.map(toMetricResultType),
  };
}
