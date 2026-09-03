import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { AlertAcknowledgeService } from '../../alerting/alert-acknowledge.service';
import { AlertQueryService } from '../../alerting/alert-query.service';
import { Alert } from '../../alerting/entities/alert.entity';
import { AlertResult } from '../../alerting/types';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { GRAPHQL_PUBSUB } from '../pubsub.provider';
import { alertRaisedTrigger } from '../subscription-triggers';

/**
 * §4.1's `activeAlerts`/`acknowledgeAlert`/`alertRaised` - deferred in
 * Phase 4 because no `Alert` entity existed yet, built here on top of
 * §5a's full dedup/suppression/escalation pipeline
 * (`AlertPipelineService`/`AlertEngineService`).
 *
 * `alertRaised` takes an explicit `tenantId` argument, not just the
 * spec'd `orgUnitId` - the same limitation `queueLiveStateUpdated`
 * (Phase 4) already has: a `graphql-ws` subscription connection doesn't
 * reliably carry `TenantContextService`'s HTTP-header-bound context, so
 * the trigger has to be keyed off something the client passes explicitly.
 * `orgUnitId` is still accepted for API-shape compatibility but not
 * functional - no upstream payload in this module carries `org_unit_id`
 * (design doc assumption 5), same as `activeAlerts`'s own limitation.
 */
@Resolver(() => AlertResult)
export class AlertResolver {
  constructor(
    private readonly alertQuery: AlertQueryService,
    private readonly alertAcknowledge: AlertAcknowledgeService,
    private readonly tenantContext: TenantContextService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  @Query(() => [AlertResult], { name: 'activeAlerts' })
  async activeAlerts(
    @Args('orgUnitId', { type: () => ID, nullable: true }) _orgUnitId?: string,
  ): Promise<AlertResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const alerts = await this.alertQuery.listActiveAlerts(tenantId);
    return alerts.map(toAlertResult);
  }

  @Mutation(() => AlertResult)
  async acknowledgeAlert(@Args('alertId', { type: () => ID }) alertId: string): Promise<AlertResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.requireActorId();
    const alert = await this.alertAcknowledge.acknowledge(tenantId, alertId, actorId);
    return toAlertResult(alert);
  }

  @Subscription(() => AlertResult, { name: 'alertRaised' })
  alertRaised(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('orgUnitId', { type: () => ID, nullable: true }) _orgUnitId?: string,
  ): AsyncIterator<unknown> {
    return this.pubSub.asyncIterator(alertRaisedTrigger(tenantId));
  }
}

function toAlertResult(alert: Alert): AlertResult {
  return {
    id: alert.id,
    alertType: alert.alertType,
    severity: alert.severity,
    orgUnitId: alert.orgUnitId,
    queueId: alert.queueId,
    status: alert.status,
    dedupGroupId: alert.dedupGroupId,
    createdAt: alert.createdAt,
    lastTriggeredAt: alert.lastTriggeredAt,
    escalatedAt: alert.escalatedAt,
    acknowledgedBy: alert.acknowledgedBy,
    acknowledgedAt: alert.acknowledgedAt,
    resolvedAt: alert.resolvedAt,
  };
}
