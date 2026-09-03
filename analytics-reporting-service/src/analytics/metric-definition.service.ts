import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MetricDefinition, MetricCategory } from './entities/metric-definition.entity';
import { MetricValidationService, CalculationDefinition } from './metric-validation.service';
import { MetricNameAlreadyExistsError } from './errors/metric-validation-failed.error';

export interface CreateMetricDefinitionInput {
  name: string;
  category: MetricCategory;
  calculationDefinition: CalculationDefinition;
}

/**
 * Phase 5 (§0.5/§2.3 rule 2, ADR-0110): the write path Phase 5's own
 * validation pipeline needed to have any real effect - §4.1 never named a
 * `createMetricDefinition` mutation, added here as a structurally
 * necessary addition (same "add what a described capability structurally
 * requires" precedent as `saved_report.name`).
 *
 * A tenant-authored `MetricDefinition` created here is a **named view onto
 * an already-whitelisted source-view column** (ADR-0110's own framing) -
 * `MetricValidationService.validateAndTier` enforces the identical
 * `SOURCE_VIEW_REGISTRY` whitelist `MetricQueryEngineService` checks at
 * query time, plus a real dry-run, before this method ever inserts a row.
 * A definition that fails either check is rejected outright - nothing is
 * ever stored with `validatedAt: null`.
 */
@Injectable()
export class MetricDefinitionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly validation: MetricValidationService,
  ) {}

  async createMetricDefinition(tenantId: string, input: CreateMetricDefinitionInput): Promise<MetricDefinition> {
    const { validatedAt, estimatedCostTier } = await this.validation.validateAndTier(
      tenantId,
      input.name,
      input.calculationDefinition,
    );

    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(MetricDefinition, { where: { tenantId, name: input.name } });
      if (existing) {
        throw new MetricNameAlreadyExistsError(input.name);
      }

      const id = randomUUID();
      await manager.insert(MetricDefinition, {
        id,
        tenantId,
        name: input.name,
        calculationDefinition: asJsonbValue(input.calculationDefinition),
        category: input.category,
        validatedAt,
        estimatedCostTier,
      });
      return manager.findOneByOrFail(MetricDefinition, { id });
    });
  }

  /**
   * §3/§4's dashboard widget picker and custom-metric-builder "your
   * metrics" list both need to enumerate what's actually queryable -
   * neither §4.1 nor Phase 5's own ADR-0110 named this query, but without
   * it a tenant-authored `MetricDefinition` (created via
   * `createMetricDefinition`) is invisible to every other page in this
   * phase forever, and the widget picker could only ever offer this
   * module's six hardcoded platform-default names. Same
   * tenant-row-plus-platform-default-rows shape `MetricQueryEngineService.
   * findVisibleMetricByName` already reads, just unfiltered by name.
   */
  async listVisibleMetrics(tenantId: string): Promise<MetricDefinition[]> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const [tenantOwned, platformDefaults] = await Promise.all([
        manager.find(MetricDefinition, { where: { tenantId }, order: { name: 'ASC' } }),
        manager.find(MetricDefinition, { where: { tenantId: IsNull() }, order: { name: 'ASC' } }),
      ]);
      return [...platformDefaults, ...tenantOwned];
    });
  }
}

// Own copy of adherence-compliance-service's `asJsonbValue` (ADR-0039
// precedent) - see dashboard.service.ts's own copy for why this cast
// exists (TypeORM's `insert()` typing quirk for jsonb columns).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: CalculationDefinition): any {
  return value;
}
