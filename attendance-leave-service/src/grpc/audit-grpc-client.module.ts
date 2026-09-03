import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuditGrpcClientService } from './audit-grpc-client.service';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

/**
 * Phase 6 (§5.1, ADR-0079): this service's first gRPC *client* (Phase 5
 * only ever made it a gRPC server). Calls into core's own
 * `AuditService.RecordEvent` (`src/grpc/controllers/audit-grpc.controller.ts`),
 * the same fire-and-forget-from-the-caller's-perspective contract every
 * other internal caller of that RPC uses (`audit.proto`'s own header
 * comment).
 *
 * `protoPath` is resolved from `process.cwd()`, not `__dirname` - this
 * service does not own a copy of `audit.proto` (core's is the single
 * source of truth, same "no duplicate copy checked in" posture ADR-0078
 * already established for scheduling-service pointing at *this* service's
 * `leave.proto`). Unlike that Python case (protoc runs once, at codegen
 * time, so a `__dirname`-relative path baked into a generated file would
 * be wrong), `@grpc/proto-loader` resolves this path at process start, and
 * `__dirname` differs between `ts-node` dev mode (`src/grpc/`) and a
 * production build (`dist/src/grpc/`) - a single hardcoded relative offset
 * from `__dirname` would be correct for exactly one of those two cases.
 * `process.cwd()` does not have that problem: both `npm run start:dev` and
 * `npm run start:prod` are already run from this service's own directory
 * (every other file in this service that reads `.env` relies on the same
 * assumption), so `../src/grpc/proto/audit.proto` from here always lands
 * on core's checked-in proto regardless of dev/build mode.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: AUDIT_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.core.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/audit.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
  ],
  providers: [AuditGrpcClientService],
  exports: [AuditGrpcClientService],
})
export class AuditGrpcClientModule {}
