/**
 * Split out from `schedule-query-grpc-client.module.ts` to avoid the same
 * circular-import failure `AUDIT_GRPC_PACKAGE`'s own doc comment documents
 * (attendance-leave-service/src/grpc/audit-grpc-client.constants.ts) - the
 * module imports the service, and the service needs this token to
 * `@Inject` the `ClientGrpc` proxy.
 */
export const SCHEDULE_QUERY_GRPC_PACKAGE = 'SCHEDULE_QUERY_GRPC_PACKAGE';
