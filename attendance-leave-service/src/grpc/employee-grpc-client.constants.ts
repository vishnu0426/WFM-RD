/**
 * Split out from `employee-grpc-client.module.ts` for the same reason
 * `audit-grpc-client.constants.ts`/`calendar-grpc-client.constants.ts` are -
 * see those files' own doc comments for the circular-import failure mode
 * this avoids.
 */
export const EMPLOYEE_GRPC_PACKAGE = 'EMPLOYEE_GRPC_PACKAGE';
