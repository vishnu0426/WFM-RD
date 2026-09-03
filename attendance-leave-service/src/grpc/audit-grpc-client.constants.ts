/**
 * Split out from `audit-grpc-client.module.ts` specifically to avoid a
 * circular import: the module imports `AuditGrpcClientService`, and the
 * service needs this token to `@Inject` the `ClientGrpc` proxy - if the
 * token lived in the module file, the two files would import each other.
 * Caught by real-build verification (`node dist/src/main.js`), not unit
 * tests: Nest's DI container failed at boot with "a circular dependency
 * has been detected inside AuditGrpcClientModule," a failure mode a
 * mocked-constructor unit test never exercises (see this service's own
 * `audit-grpc-client.service.spec.ts`, which constructs the service
 * directly and never touches either module file).
 */
export const AUDIT_GRPC_PACKAGE = 'AUDIT_GRPC_PACKAGE';
