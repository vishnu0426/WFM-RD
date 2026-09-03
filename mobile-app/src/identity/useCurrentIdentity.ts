import { useAuth } from '@/auth/AuthContext';

/**
 * `tenantId` is real, sourced from the authenticated session's JWT
 * `tenant_id` claim (Phase 2, docs/adr/0150) — this hook must only be
 * called from inside the authenticated (tabs) stack, where `AuthContext`
 * guarantees `claims` is populated.
 *
 * `employeeId` is STILL a dev-only stub. There is no `userId -> Employee`
 * resolution anywhere in the platform API today (inherited from Module 02,
 * not something Module 11 should invent a workaround for — see
 * docs/adr/0150). Gated on the same `EXPO_PUBLIC_APP_ENV !== 'production'`
 * check `DevIdentityBanner` uses, so a production build can't silently
 * fall back to an undefined dev employee id in a build where `tenantId` is
 * now legitimately real.
 */
export interface CurrentIdentity {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
}

export function useCurrentIdentity(): CurrentIdentity {
  const { claims } = useAuth();
  if (!claims) {
    throw new Error('useCurrentIdentity() was called before authentication completed.');
  }

  const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_API_BASE_URL. Copy .env.example to .env.');
  }

  const isProductionBuild = process.env.EXPO_PUBLIC_APP_ENV === 'production';
  const employeeId = process.env.EXPO_PUBLIC_DEV_EMPLOYEE_ID;
  if (!employeeId || isProductionBuild) {
    throw new Error(
      'employeeId cannot be resolved from the signed-in session - no userId -> Employee ' +
        'lookup exists in the platform API yet (docs/adr/0150). Non-production builds fall ' +
        'back to EXPO_PUBLIC_DEV_EMPLOYEE_ID (copy .env.example to .env); a production build ' +
        'has no fallback and must not run this screen until that gap is closed.',
    );
  }

  return { employeeId, tenantId: claims.tenant_id, apiBaseUrl };
}
