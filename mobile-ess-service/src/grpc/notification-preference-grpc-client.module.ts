import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { NotificationPreferenceGrpcClientService } from './notification-preference-grpc-client.service';
import { NOTIFICATION_PREFERENCE_GRPC_PACKAGE } from './notification-preference-grpc-client.constants';

/**
 * ADR-0154: this service's second gRPC-inbound-to-core direction (after
 * none yet - this service's first cross-service call was Phase 3-4's
 * plain REST/HMAC providers, not gRPC), same direction/template as
 * `shift-marketplace-service`'s own `EmployeeGrpcClientModule` - platform-
 * core exposes, this service calls in, exactly the established pattern.
 *
 * `protoPath` points at core's own checked-in proto - no local copy in
 * this service, same "single source of truth lives with the owning
 * service" posture. Resolved from `process.cwd()`, not `__dirname`, same
 * reason every other gRPC client module in this platform uses it.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: NOTIFICATION_PREFERENCE_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.core.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/notification.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
  ],
  providers: [NotificationPreferenceGrpcClientService],
  exports: [NotificationPreferenceGrpcClientService],
})
export class NotificationPreferenceGrpcClientModule {}
