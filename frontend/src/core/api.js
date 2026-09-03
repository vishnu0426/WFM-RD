/* core/api.js — real backend API client shared by every module. PKCE OAuth
   login + REST/GraphQL helpers against the root service (:3000),
   attendance-leave-service (:8300), and scheduling-service (:8100).
   `window.WFM_CONFIG`, if set before this module loads, still overrides the
   defaults (see RUN.md) — same convention the pre-module version used. */
export const WFM_CONFIG = (typeof window !== 'undefined' && window.WFM_CONFIG) || {
  rootBaseUrl: 'http://localhost:3000',
  leaveBaseUrl: 'http://localhost:8300',
  schedulingBaseUrl: 'http://localhost:8100',
  forecastingBaseUrl: 'http://localhost:8000',
  intradayBaseUrl: 'http://localhost:8200',
  integrationHubBaseUrl: 'http://localhost:8900',
  analyticsBaseUrl: 'http://localhost:8600',
  adherenceComplianceBaseUrl: 'http://localhost:8500',
  clientId: 'demo-web-app',
  redirectUri: 'http://localhost:3000/callback',
};

export const Api = (() => {
  const CFG = WFM_CONFIG;
  const STORAGE_KEY = 'wfm.auth';

  function loadTokens() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveTokens(t) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* sessionStorage unavailable — session simply won't persist across reloads */
    }
  }

  function clearTokens() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }

  function isAuthenticated() {
    const t = loadTokens();
    return !!(t && t.accessToken && t.expiresAt > Date.now());
  }

  function currentUserClaims() {
    const t = loadTokens();
    if (!t || !t.accessToken) return null;
    try {
      const payload = t.accessToken.split('.')[1];
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch {
      return null;
    }
  }

  /* ---------- PKCE ---------- */
  function base64url(bytes) {
    let str = '';
    bytes.forEach((b) => (str += String.fromCharCode(b)));
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomVerifier() {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    return base64url(bytes).slice(0, 128);
  }

  async function challengeFromVerifier(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64url(new Uint8Array(digest));
  }

  /* ---------- error normalization ----------
   * Three distinct envelope shapes exist across this platform:
   *  - custom DomainErrorFilter:  { error: { code, message, details } }
   *  - OAuth (RFC 6749/7009):     { error: "invalid_request", error_description: "..." }
   *  - Nest's default filter:    { statusCode, message, error } — message may be an array
   */
  function normalizeError(status, body) {
    if (body && typeof body === 'object') {
      if (body.error && typeof body.error === 'object' && 'code' in body.error) {
        return { status, code: body.error.code, message: body.error.message || 'Request failed.' };
      }
      if (typeof body.error === 'string' && 'error_description' in body) {
        return { status, code: body.error, message: body.error_description || body.error };
      }
      if ('statusCode' in body) {
        const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message;
        return { status, code: body.error || String(body.statusCode), message: msg || 'Request failed.' };
      }
    }
    return { status, code: 'UNKNOWN', message: `Request failed (${status}).` };
  }

  /* ---------- login / token refresh ---------- */
  async function login(usernameOrEmail, password) {
    const verifier = randomVerifier();
    const challenge = await challengeFromVerifier(verifier);

    const authRes = await fetch(`${CFG.rootBaseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CFG.clientId,
        redirect_uri: CFG.redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'openid',
        username: usernameOrEmail,
        password,
      }),
    });
    const authBody = await authRes.json().catch(() => ({}));
    if (!authRes.ok) throw normalizeError(authRes.status, authBody);

    const tokenRes = await fetch(`${CFG.rootBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: authBody.code,
        redirect_uri: CFG.redirectUri,
        code_verifier: verifier,
        client_id: CFG.clientId,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw normalizeError(tokenRes.status, tokenBody);

    storeTokenResponse(tokenBody);
    return currentUserClaims();
  }

  function storeTokenResponse(tokenBody) {
    saveTokens({
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      idToken: tokenBody.id_token || null,
      expiresAt: Date.now() + (tokenBody.expires_in || 900) * 1000 - 5000,
    });
  }

  async function refresh() {
    const t = loadTokens();
    if (!t || !t.refreshToken) throw { status: 401, code: 'NO_REFRESH_TOKEN', message: 'Not logged in.' };
    const res = await fetch(`${CFG.rootBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
        client_id: CFG.clientId,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      clearTokens();
      throw normalizeError(res.status, body);
    }
    storeTokenResponse(body);
  }

  function logout() {
    clearTokens();
  }

  /* ---------- REST ---------- */
  async function apiFetch(baseUrl, path, opts = {}, { _retried = false } = {}) {
    const t = loadTokens();
    const headers = Object.assign({}, opts.headers || {});
    if (t && t.accessToken) {
      headers['Authorization'] = `Bearer ${t.accessToken}`;
      /* Some services (integration-hub-service, ai-layer-service — ADR-0014's
         disclosed placeholder) resolve tenant scope from this header rather
         than the JWT's own tenant_id claim, then cross-check the two
         (TenantTokenMatchGuard). Harmless no-op for services that only ever
         read tenant_id from the token itself, like the root service. */
      const claims = currentUserClaims();
      if (claims && claims.tenant_id) headers['x-tenant-id'] = claims.tenant_id;
    }
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    if (opts.body != null && !isForm && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const body = opts.body != null && !isForm && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;

    const res = await fetch(`${baseUrl}${path}`, { ...opts, headers, body });

    if (res.status === 401 && !_retried && t && t.refreshToken) {
      try {
        await refresh();
        return apiFetch(baseUrl, path, opts, { _retried: true });
      } catch {
        /* fall through to normal error handling below */
      }
    }

    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw normalizeError(res.status, json);
    return json;
  }

  const rootApi = (path, opts) => apiFetch(CFG.rootBaseUrl, path, opts);
  const leaveApi = (path, opts) => apiFetch(CFG.leaveBaseUrl, path, opts);
  const schedulingApi = (path, opts) => apiFetch(CFG.schedulingBaseUrl, path, opts);
  const forecastingApi = (path, opts) => apiFetch(CFG.forecastingBaseUrl, path, opts);
  const intradayApi = (path, opts) => apiFetch(CFG.intradayBaseUrl, path, opts);
  const analyticsApi = (path, opts) => apiFetch(CFG.analyticsBaseUrl, path, opts);
  const integrationHubApi = (path, opts) => apiFetch(CFG.integrationHubBaseUrl, path, opts);
  const adherenceComplianceApi = (path, opts) => apiFetch(CFG.adherenceComplianceBaseUrl, path, opts);

  /* ---------- GraphQL ---------- */
  async function gqlFetchAt(baseUrl, query, variables) {
    const body = await apiFetch(baseUrl, '/graphql', { method: 'POST', body: { query, variables } });
    if (body.errors && body.errors.length) {
      const e = body.errors[0];
      throw { status: 400, code: (e.extensions && e.extensions.code) || 'GRAPHQL_ERROR', message: e.message };
    }
    return body.data;
  }
  const gqlFetch = (query, variables) => gqlFetchAt(CFG.rootBaseUrl, query, variables);
  const integrationHubGql = (query, variables) => gqlFetchAt(CFG.integrationHubBaseUrl, query, variables);
  /* Scorecards Sources (Tenant Admin Integration Management WP6) is the first screen to call analytics-reporting-service's GraphQL schema. */
  const analyticsGql = (query, variables) => gqlFetchAt(CFG.analyticsBaseUrl, query, variables);

  /* ---------- CSV export helper (client-side, no backend endpoint) ---------- */
  function downloadCsv(filename, rows, columns) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.map((c) => esc(c.label)).join(',');
    const lines = rows.map((row) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','));
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    login,
    logout,
    refresh,
    isAuthenticated,
    currentUserClaims,
    rootApi,
    leaveApi,
    schedulingApi,
    forecastingApi,
    intradayApi,
    analyticsApi,
    integrationHubApi,
    adherenceComplianceApi,
    gqlFetch,
    gqlFetchAt,
    integrationHubGql,
    analyticsGql,
    downloadCsv,
  };
})();
