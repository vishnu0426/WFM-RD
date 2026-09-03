/**
 * Split out from `calendar-grpc-client.module.ts` for the same reason
 * `audit-grpc-client.constants.ts` is - see that file's own doc comment
 * for the circular-import failure mode this avoids (a real bug Phase 6's
 * own real-build verification caught).
 */
export const CALENDAR_GRPC_PACKAGE = 'CALENDAR_GRPC_PACKAGE';
