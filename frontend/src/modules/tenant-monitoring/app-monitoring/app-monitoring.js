/* Platform > Application Monitoring — a live health view across every
   backend service, plus a link out to the already-provisioned Grafana
   dashboards. No new backend code: every service already exposes real,
   unauthenticated, root-relative GET /healthz (liveness, always 200) and
   GET /readyz (readiness — Postgres/Redis) endpoints (see each service's
   own src/common/health/health.controller.ts), and CORS already defaults
   to allowing http://localhost:5173 (src/main.ts). Plain fetch() is used
   here rather than Api.rootApi/etc — those attach an unneeded
   Authorization header and assume a JSON-error-envelope shape neither
   endpoint needs, and a raw fetch is easier to bound with its own timeout
   so one unreachable service can't stall the whole grid.

   Base URLs are hardcoded here rather than read from window.WFM_CONFIG —
   simpler than threading per-module config-key naming (some modules use
   camelCase keys declared in index.html, others snake_case keys that
   aren't declared there at all and silently fall back to their own
   defaults) into one grid. frontend/index.html's own rootBaseUrl used to
   default to :3001, the same host port docker-compose.yml maps Grafana
   to — fixed to :3000 (this app's real default port, src/main.ts) as part
   of this feature, since nothing actually listened on :3001 without a
   manual proxy. */
import { esc } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { pageHead, sec } from '../../identity-org/shared/ui.js';

const SERVICES = [
  { name: 'Root / Identity / Auth', baseUrl: 'http://localhost:3000' },
  { name: 'Scheduling', baseUrl: 'http://localhost:8100' },
  { name: 'Forecasting', baseUrl: 'http://localhost:8000' },
  { name: 'Intraday', baseUrl: 'http://localhost:8200' },
  { name: 'Leave / Attendance', baseUrl: 'http://localhost:8300' },
  { name: 'Shift Marketplace', baseUrl: 'http://localhost:8400' },
  { name: 'Adherence & Compliance', baseUrl: 'http://localhost:8500' },
  { name: 'Analytics & Reporting', baseUrl: 'http://localhost:8600' },
  { name: 'AI Layer', baseUrl: 'http://localhost:8700' },
  { name: 'Mobile ESS', baseUrl: 'http://localhost:8800' },
  { name: 'Integration Hub', baseUrl: 'http://localhost:8900' },
];

const PING_TIMEOUT_MS = 4000;
const GRAFANA_URL = 'http://localhost:3001';

async function pingOne(baseUrl, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body, ignore */ }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: null, error: err.name === 'AbortError' ? 'Timed out' : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function pingService(svc) {
  const [live, ready] = await Promise.all([pingOne(svc.baseUrl, '/healthz'), pingOne(svc.baseUrl, '/readyz')]);
  return {
    name: svc.name,
    baseUrl: svc.baseUrl,
    live: live.ok ? 'ok' : (live.error || `HTTP ${live.status}`),
    ready: ready.ok ? (ready.body?.status || 'ok') : (ready.error || `HTTP ${ready.status}`),
    readyDetail: ready.body,
    checkedAt: new Date(),
  };
}

async function loadHealthGrid(state) {
  state.wf.healthGrid = { loading: true };
  doRerender();
  const results = await Promise.all(SERVICES.map(pingService));
  state.wf.healthGrid = { results };
  doRerender();
}

function statusBadge(status) {
  return status === 'ok'
    ? `<span class="badge badge-ok"><span class="pip"></span>ok</span>`
    : `<span class="badge badge-sys"><span class="pip"></span>${esc(String(status))}</span>`;
}

function healthGridCard(state) {
  const cache = state.wf.healthGrid;
  const loading = !cache || cache.loading;
  const rows = (cache && cache.results) || [];
  const body = loading
    ? `<div class="skel" style="height:120px"></div>`
    : `<table class="data"><thead><tr><th>Service</th><th>Live (/healthz)</th><th>Ready (/readyz)</th><th>Detail</th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td><b>${esc(r.name)}</b><br/><span class="meta">${esc(r.baseUrl)}</span></td>
          <td>${statusBadge(r.live)}</td>
          <td>${statusBadge(r.ready)}</td>
          <td class="meta">${r.readyDetail ? esc(JSON.stringify(r.readyDetail)) : '—'}</td>
        </tr>`).join('')}
      </tbody></table>
      <p class="hint" style="margin-top:8px">Last checked ${rows[0] ? rows[0].checkedAt.toLocaleTimeString() : '—'}.</p>`;
  return sec('Service Health', `
    <div class="actions" style="margin-bottom:10px">
      <button class="btn" data-act="am-refresh" ${loading ? 'disabled' : ''}>${loading ? 'Checking…' : 'Refresh'}</button>
    </div>
    ${body}
  `, `<span class="meta">Direct browser fetch, no auth — same endpoints Kubernetes-style liveness/readiness probes would use</span>`);
}

function dashboardsCard() {
  return sec('Dashboards', `
    <p style="margin:0 0 10px"><a class="btn" href="${GRAFANA_URL}" target="_blank" rel="noopener">Open Grafana</a></p>
    <p class="hint">Requires <code>docker-compose up -d prometheus grafana</code> running locally (real per-module SLO dashboards are already provisioned under <code>observability/</code>). Grafana is mapped to host port 3001 (<code>docker-compose.yml</code>) — this app's own frontend config (<code>frontend/index.html</code>) now points its root API at port 3000 directly, so no port collision between the two.</p>
  `, '');
}

export function render(state) {
  if (state.wf.healthGrid === undefined) loadHealthGrid(state);
  return `
    ${pageHead('Application Monitoring', 'Live service health across the whole platform, plus a link to the full Grafana dashboards.', '')}
    ${healthGridCard(state)}
    ${dashboardsCard()}
  `;
}

export function handle(state, act) {
  if (act === 'am-refresh') {
    loadHealthGrid(state);
    return true;
  }
  return false;
}
