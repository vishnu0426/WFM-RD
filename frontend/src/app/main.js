/* Single entry point loaded by index.html. Decides which top-level shell to
   boot: the tenant-facing product shell (shell.js — User Management,
   Forecasting and Scheduling) or the internal, platform_admin-only console
   (platform-admin-shell.js — Tenant Monitoring). platform_admin is an
   exclusive mode (see current-user.js's currentUserIsPlatformAdmin doc
   comment) decided here, before either shell's own code runs — neither
   shell file imports or knows about the other.

   If there's no valid session yet, we can't know the role in advance, so
   this defaults to shell.js — the one place in the app with a login
   screen. If that login turns out to belong to a platform_admin, its own
   submit handler reloads the page; on the reload, isAuthenticated() is now
   true and this file routes to platform-admin-shell.js instead. */
import { Api } from '../core/api.js';
import { currentUserIsPlatformAdmin } from './current-user.js';

async function boot() {
  if (Api.isAuthenticated() && currentUserIsPlatformAdmin()) {
    const { boot: bootPlatformAdmin } = await import('./platform-admin-shell.js');
    bootPlatformAdmin();
    return;
  }
  const { boot: bootShell } = await import('./shell.js');
  bootShell();
}

boot();
