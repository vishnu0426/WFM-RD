/* Typed client stub for Mobile / ESS backend (Module 11) — the Expo mobile-app is the actual client; this would be an admin-facing web view — service listens on :8800 (see repo-root
   RUN.md's port table). No screen in this app calls this service yet; this
   exists so the module folder is real and wired the moment a screen needs
   it, matching the convention every other modules/* folder here uses. */
const BASE_URL = (typeof window !== 'undefined' && window.WFM_CONFIG && window.WFM_CONFIG.mobile_essBaseUrl) || 'http://localhost:8800';

export async function healthCheck() {
  const res = await fetch(`${BASE_URL}/healthz`);
  if (!res.ok) throw new Error(`mobile-ess health check failed (${res.status})`);
  return res.json().catch(() => ({ status: 'ok' }));
}
