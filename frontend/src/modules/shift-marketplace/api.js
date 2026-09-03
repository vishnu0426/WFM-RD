/* Typed client stub for Shift Marketplace (Module 07) — service listens on :8400 (see repo-root
   RUN.md's port table). No screen in this app calls this service yet; this
   exists so the module folder is real and wired the moment a screen needs
   it, matching the convention every other modules/* folder here uses. */
const BASE_URL = (typeof window !== 'undefined' && window.WFM_CONFIG && window.WFM_CONFIG.shift_marketplaceBaseUrl) || 'http://localhost:8400';

export async function healthCheck() {
  const res = await fetch(`${BASE_URL}/healthz`);
  if (!res.ok) throw new Error(`shift-marketplace health check failed (${res.status})`);
  return res.json().catch(() => ({ status: 'ok' }));
}
