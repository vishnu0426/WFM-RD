import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_METADATA_KEY = 'requiredPermissions';

/**
 * Own copy of `ai-layer-service`'s decorator - identical shape. Marks a
 * handler as requiring the named `resource:action` permission(s), enforced
 * by `PermissionsGuard`, which must run after `AccessTokenGuard` (it reads
 * `request.tokenClaims`). Multiple permissions are AND'd - the caller needs
 * all of them.
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
