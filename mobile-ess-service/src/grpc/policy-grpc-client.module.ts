import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { PolicyGrpcClientService } from './policy-grpc-client.service';
import { POLICY_GRPC_PACKAGE } from './policy-grpc-client.constants';

/**
 * ADR-0155: this service's first `PolicyService` client, and this
 * platform's first cross-service consumer of `GetActivePolicy` at all
 * (confirmed by grep - every prior reference to `policy.proto` was only
 * `src/main.ts`'s own registration). The RPC itself is already
 * production-ready (Module 02 Phase 4); this is a new consumer, not new
 * core-side infrastructure. Same `protoPath`-from-`process.cwd()`
 * template as this service's own `employee-grpc-client.module.ts`/
 * `notification-preference-grpc-client.module.ts`.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: POLICY_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.core.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/policy.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
  ],
  providers: [PolicyGrpcClientService],
  exports: [PolicyGrpcClientService],
})
export class PolicyGrpcClientModule {}
