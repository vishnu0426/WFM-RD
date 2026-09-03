import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_SUBJECTS, StaffingOfferCreatedPayload } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { QueueLiveStateRecord } from '../redis/types';
import { StaffingOffer, StaffingOfferType } from './entities/staffing-offer.entity';

/** A queue running 10+ points over its own service-level target has spare capacity worth offering as VTO - same threshold/reasoning `ReallocationRecommendationService` already uses to call a queue a "donor". */
const SURPLUS_THRESHOLD = 0.1;

/** A queue running 10+ points under target is worth offering overtime on, independent of whether a reallocation donor exists elsewhere - agents extending their current session, not agents coming in on a day off (this platform has no "who's off today" signal to draw from). */
const DEFICIT_THRESHOLD = 0.1;

/**
 * Detection + push-notification-trigger only, per this pass's scope -
 * creates `StaffingOffer` rows and publishes `STAFFING_OFFER_CREATED` for
 * mobile-ess-service to turn into a push notification. Deliberately does
 * NOT implement: accept/decline, a materialized scheduling-service
 * `shift_event_request` on acceptance, or contracted-hours-cap eligibility
 * filtering for overtime (that would need a first-ever gRPC client from
 * this service to scheduling-service's `SchedulingEligibilityService` -
 * real new infrastructure, deliberately not bolted on as a rushed side
 * effect of this feature). Eligible population is simply "every agent
 * Redis has tracked as a member of this queue right now"
 * (`IntradayRedisService.listQueueMembers`), the same primitive
 * `ReallocationRecommendationService` already reads - broadcast, not
 * ranked or filtered.
 *
 * Called from `QueueMetricsUpdatedConsumerService`, the same fan-out point
 * as `AlertEngineService`/`ReallocationRecommendationService`.
 */
@Injectable()
export class StaffingOfferService {
  private readonly logger = new Logger(StaffingOfferService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: IntradayRedisService,
    private readonly nats: IntradayNatsClientService,
  ) {}

  async evaluateQueueMetrics(tenantId: string, queueId: string, record: QueueLiveStateRecord): Promise<void> {
    if (record.serviceLevelCurrent === null || record.serviceLevelTarget === null) {
      return;
    }
    const gap = record.serviceLevelCurrent - record.serviceLevelTarget;
    if (gap > SURPLUS_THRESHOLD) {
      await this.offer(
        tenantId,
        queueId,
        'vto',
        `Queue ${queueId} is running ${(gap * 100).toFixed(1)} points over its service-level target of ${record.serviceLevelTarget}.`,
      );
    } else if (-gap > DEFICIT_THRESHOLD) {
      await this.offer(
        tenantId,
        queueId,
        'overtime',
        `Queue ${queueId} is running ${(-gap * 100).toFixed(1)} points under its service-level target of ${record.serviceLevelTarget}.`,
      );
    }
  }

  private async offer(tenantId: string, queueId: string, offerType: StaffingOfferType, reason: string): Promise<void> {
    const members = await this.redis.listQueueMembers(tenantId, queueId);
    if (members.length === 0) {
      return;
    }

    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(StaffingOffer);
      for (const employeeId of members) {
        // Repeat-guard: offers never leave 'offered' in this phase (no
        // accept/decline yet), so this is "never re-offer the same
        // (queue, employee, type) combination twice" - acceptable for a
        // detection+push-only pass; a real expiry/TTL is a follow-up once
        // offers have a terminal status to expire into.
        const existing = await repository.findOne({ where: { tenantId, queueId, employeeId, offerType } });
        if (existing) {
          continue;
        }

        const offer = new StaffingOffer();
        offer.id = randomUUID();
        offer.tenantId = tenantId;
        offer.queueId = queueId;
        offer.offerType = offerType;
        offer.employeeId = employeeId;
        offer.reason = reason;
        offer.status = 'offered';
        offer.createdAt = new Date();
        await repository.save(offer);
        await this.publishCreated(offer);
      }
    });
  }

  private async publishCreated(offer: StaffingOffer): Promise<void> {
    const payload: StaffingOfferCreatedPayload = {
      tenantId: offer.tenantId,
      staffingOfferId: offer.id,
      queueId: offer.queueId,
      offerType: offer.offerType,
      employeeId: offer.employeeId,
      reason: offer.reason,
    };
    try {
      await this.nats.publish(INTRADAY_SUBJECTS.STAFFING_OFFER_CREATED, payload as unknown as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(`Failed to publish staffing_offer.created for ${offer.id}: ${(err as Error).message}`);
    }
  }
}
