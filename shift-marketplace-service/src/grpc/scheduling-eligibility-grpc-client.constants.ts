/**
 * Split out from `scheduling-eligibility-grpc-client.module.ts` specifically
 * to avoid a circular import - same reasoning as attendance-leave-service's
 * own `audit-grpc-client.constants.ts`.
 */
export const SCHEDULING_ELIGIBILITY_GRPC_PACKAGE = 'SCHEDULING_ELIGIBILITY_GRPC_PACKAGE';
