import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { MobileEssNatsModule } from '../nats/nats.module';
import { NotificationPreferenceGrpcClientModule } from '../grpc/notification-preference-grpc-client.module';
import { ExpoPushClient } from './expo-push-client';
import { PushDispatchService } from './push-dispatch.service';
import { LeaveRequestApprovedConsumerService } from './consumers/leave-request-approved.consumer';
import { StaffingOfferCreatedConsumerService } from './consumers/staffing-offer-created.consumer';

/**
 * ADR-0154 §B: the NATS-consumer + gRPC-preference-check + Expo-push-send
 * pipeline. `MobileEssNatsModule` is `@Global`, imported here anyway for
 * clarity (matches `intraday-service`'s own consumer modules' style).
 * `StaffingOfferCreatedConsumerService` adds a second event type/producer
 * (intraday-service) onto the same `PushDispatchService` pipeline.
 */
@Module({
  imports: [DevicesModule, MetricsModule, MobileEssNatsModule, NotificationPreferenceGrpcClientModule],
  providers: [
    ExpoPushClient,
    PushDispatchService,
    LeaveRequestApprovedConsumerService,
    StaffingOfferCreatedConsumerService,
  ],
})
export class PushModule {}
