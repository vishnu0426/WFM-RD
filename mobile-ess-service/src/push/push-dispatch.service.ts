import { Injectable, Logger } from '@nestjs/common';
import { DevicesService } from '../devices/devices.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { NotificationPreferenceGrpcClientService } from '../grpc/notification-preference-grpc-client.service';
import { LeaveRequestApprovedPayload, StaffingOfferCreatedPayload } from '../nats/subjects';
import { ExpoPushClient } from './expo-push-client';
import { ExpoPushForwardFailedError } from './errors/expo-push-forward-failed.error';

const LEAVE_REQUEST_APPROVED_EVENT_TYPE = 'leave.request.approved';
const STAFFING_OFFER_CREATED_EVENT_TYPE = 'staffing.offer.created';

/**
 * ADR-0154 §B. The narrow, real slice standing in for "Module 01's
 * notification center" (which turns out not to exist as a dispatcher,
 * ADR-0154 §2) - exactly one event type, one channel (push), reused
 * end to end: preference check (gRPC into platform-core) -> registered
 * device lookup (this service's own table) -> Expo send -> dead-token
 * cleanup.
 *
 * Ack/nak contract (called from `LeaveRequestApprovedConsumerService.handlePayload`):
 * only the gRPC preference check propagates on failure - it's a single
 * per-event call made before anything is sent, so redelivering it is
 * risk-free. A per-device Expo send failure is caught and recorded here,
 * never propagated - devices are processed in a loop, and letting one
 * device's transient failure nak the whole event would redeliver to
 * every OTHER device on this employee's account too, duplicate-sending a
 * push to ones that already succeeded. This refines ADR-0154 §B2's
 * "transient Expo failure also naks" framing down to what's actually
 * safe given per-device fan-out.
 */
@Injectable()
export class PushDispatchService {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    private readonly devices: DevicesService,
    private readonly notificationPreferenceClient: NotificationPreferenceGrpcClientService,
    private readonly expoPushClient: ExpoPushClient,
    private readonly metrics: MetricsService,
  ) {}

  async dispatchLeaveApproved(payload: LeaveRequestApprovedPayload): Promise<void> {
    await this.sendPush(payload.tenantId, payload.employeeId, LEAVE_REQUEST_APPROVED_EVENT_TYPE, {
      title: 'Leave request approved',
      body: `Your leave request for ${payload.dateRangeStart} to ${payload.dateRangeEnd} was approved.`,
      data: { leaveRequestId: payload.leaveRequestId, eventType: LEAVE_REQUEST_APPROVED_EVENT_TYPE },
    });
  }

  /**
   * Detection + push-trigger only, per intraday-service's own
   * `StaffingOfferService` scope for this pass - the notification is
   * informational (it carries `staffingOfferId`/`queueId` in `data` for a
   * future accept/decline UI to deep-link into), there is no response
   * path back to intraday-service yet.
   */
  async dispatchStaffingOfferCreated(payload: StaffingOfferCreatedPayload): Promise<void> {
    const isVto = payload.offerType === 'vto';
    await this.sendPush(payload.tenantId, payload.employeeId, STAFFING_OFFER_CREATED_EVENT_TYPE, {
      title: isVto ? 'Voluntary time off available' : 'Overtime available',
      body: payload.reason,
      data: {
        staffingOfferId: payload.staffingOfferId,
        queueId: payload.queueId,
        offerType: payload.offerType,
        eventType: STAFFING_OFFER_CREATED_EVENT_TYPE,
      },
    });
  }

  /**
   * Shared preference-check -> device-lookup -> Expo-send -> dead-token-
   * cleanup pipeline behind both dispatch methods above.
   *
   * Ack/nak contract (called from a `DurableJetStreamConsumer.handlePayload`):
   * only the gRPC preference check propagates on failure - it's a single
   * per-event call made before anything is sent, so redelivering it is
   * risk-free. A per-device Expo send failure is caught and recorded here,
   * never propagated - devices are processed in a loop, and letting one
   * device's transient failure nak the whole event would redeliver to
   * every OTHER device on this employee's account too, duplicate-sending a
   * push to ones that already succeeded. This refines ADR-0154 §B2's
   * "transient Expo failure also naks" framing down to what's actually
   * safe given per-device fan-out.
   */
  private async sendPush(
    tenantId: string,
    employeeId: string,
    eventType: string,
    message: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<void> {
    const preference = await this.notificationPreferenceClient.isPushEnabled({ tenantId, employeeId, eventType });

    if (!preference.enabled) {
      this.metrics.recordPushDeliveryAttempt(
        preference.employeeHasLinkedUser ? 'skipped_preference_disabled' : 'skipped_no_linked_user',
      );
      return;
    }

    const devices = await this.devices.findActiveForEmployee(tenantId, employeeId);
    if (devices.length === 0) {
      this.metrics.recordPushDeliveryAttempt('skipped_no_device');
      return;
    }

    for (const device of devices) {
      try {
        const result = await this.expoPushClient.send(device.pushToken, message);
        if (result.ok) {
          this.metrics.recordPushDeliveryAttempt('sent');
          continue;
        }
        this.metrics.recordPushDeliveryAttempt('failed');
        if (result.errorType === 'DeviceNotRegistered') {
          await this.devices.markInactive(device.tenantId, device.id);
          this.metrics.recordPushDeadToken();
        }
      } catch (err) {
        if (err instanceof ExpoPushForwardFailedError) {
          this.logger.warn(`Expo push send failed for device ${device.id}: ${err.message}`);
          this.metrics.recordPushDeliveryAttempt('failed');
          continue;
        }
        throw err;
      }
    }
  }
}
