/* JWT-permission-derived current-user view, shared by the shell's top bar
   and every Roles Setup permission check (role:write / role:delete gating). */
import { Api } from '../core/api.js';

export function makeCurrentUser(state) {
  return {
    get name() {
      if (!state.me) return "…";
      return state.me.givenName || state.me.familyName
        ? `${state.me.givenName || ""} ${state.me.familyName || ""}`.trim()
        : state.me.email;
    },
    get initials() {
      if (!state.me) return "…";
      const a = (state.me.givenName || state.me.email || "?")[0];
      const b = (state.me.familyName || "")[0] || "";
      return (a + b).toUpperCase();
    },
    permissions: currentUserPermissions(),
    can(p) {
      return this.permissions.has(p);
    },
  };
}

export function currentUserPermissions() {
  const claims = Api.currentUserClaims();
  return new Set((claims && claims.permissions) || []);
}

/* platform_admin is treated as an exclusive mode, not just another
   permission-gated module — main.js reads this (before either top-level
   shell is even imported) to decide whether to boot the tenant-facing
   product shell (shell.js) or the internal-only platform-admin-shell.js,
   regardless of what other roles (tenant_admin, employee) the same account
   also happens to hold. Checks the JWT's `roles` claim directly, same hard
   role check the backend's own PlatformAdminGuard/isPlatformAdmin() use,
   not a permission string that could drift. */
export function currentUserIsPlatformAdmin() {
  const claims = Api.currentUserClaims();
  return !!(claims && Array.isArray(claims.roles) && claims.roles.includes('platform_admin'));
}
