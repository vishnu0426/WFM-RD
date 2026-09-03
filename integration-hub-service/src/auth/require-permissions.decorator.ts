import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_METADATA_KEY = 'requiredPermissions';

/**
 * Own copy of core's `require-permissions.decorator.ts` (§7 Phase 8,
 * ADR-0145) - identical shape. Marks a handler as requiring the named
 * `resource:action` permission(s) (§3.4's claim format), enforced by
 * `PermissionsGuard`, which must run after `AccessTokenGuard` (it reads
 * `request.tokenClaims`). Multiple permissions are AND'd - the caller
 * needs all of them.
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
