/**
 * Split out from `employee-grpc-client.module.ts` specifically to avoid a
 * circular import - same reasoning as attendance-leave-service's own
 * `audit-grpc-client.constants.ts`.
 */
export const EMPLOYEE_GRPC_PACKAGE = 'EMPLOYEE_GRPC_PACKAGE';
