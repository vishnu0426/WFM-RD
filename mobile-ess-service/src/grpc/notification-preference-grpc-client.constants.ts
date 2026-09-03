/**
 * Split out from `notification-preference-grpc-client.module.ts`
 * specifically to avoid a circular import - same reasoning as
 * `shift-marketplace-service`'s own `employee-grpc-client.constants.ts`.
 */
export const NOTIFICATION_PREFERENCE_GRPC_PACKAGE = 'NOTIFICATION_PREFERENCE_GRPC_PACKAGE';
