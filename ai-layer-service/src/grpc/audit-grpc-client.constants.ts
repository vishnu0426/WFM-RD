/**
 * Split out from `audit-grpc-client.module.ts` to avoid the same
 * circular-import failure attendance-leave-service's own
 * `audit-grpc-client.constants.ts` documents (found by that service's real
 * build boot, not a unit test).
 */
export const AUDIT_GRPC_PACKAGE = 'AUDIT_GRPC_PACKAGE';
