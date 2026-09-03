/* Forecasting (Module 03, :8000) client. Real REST wiring for
   forecasting-service — Campaign + CampaignQueue CRUD so far (the
   Forecasting & Scheduling console's Campaigns > Settings / Campaigns >
   Queues screens); more endpoints land here as later phases wire them. */
import { Api } from '../../core/api.js';

export async function healthCheck() {
  return Api.forecastingApi('/healthz');
}

/* ---------- Campaigns ("Campaigns" > "Settings") ---------- */
export const listCampaigns = () => Api.forecastingApi('/v1/forecasting/campaigns');
export const createCampaign = (body) => Api.forecastingApi('/v1/forecasting/campaigns', { method: 'POST', body });
export const updateCampaign = (id, body) => Api.forecastingApi(`/v1/forecasting/campaigns/${id}`, { method: 'PATCH', body });
export const deleteCampaign = (id) => Api.forecastingApi(`/v1/forecasting/campaigns/${id}`, { method: 'DELETE' });

/* ---------- Campaign queues ("Campaigns" > "Queues") ---------- */
export const listCampaignQueues = (campaignId) => Api.forecastingApi(`/v1/forecasting/campaigns/${campaignId}/queues`);
export const addCampaignQueue = (campaignId, orgUnitId) =>
  Api.forecastingApi(`/v1/forecasting/campaigns/${campaignId}/queues`, { method: 'POST', body: { orgUnitId } });
export const removeCampaignQueue = (campaignId, orgUnitId) =>
  Api.forecastingApi(`/v1/forecasting/campaigns/${campaignId}/queues/${orgUnitId}`, { method: 'DELETE' });

/* ---------- Forecast jobs ("Tactical Forecast") ----------
   POST requires an Idempotency-Key header (§3.3's submit/poll job
   contract) — a fresh one per real submission so a genuine resubmit isn't
   silently deduped against a stale one. */
export const submitForecastJob = (body) =>
  Api.forecastingApi('/v1/forecasting/jobs', { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
export const getForecastJob = (jobId) => Api.forecastingApi(`/v1/forecasting/jobs/${jobId}`);
export const getForecastJobDataPoints = (jobId) => Api.forecastingApi(`/v1/forecasting/jobs/${jobId}/data-points`);
export const listForecastJobs = (orgUnitId, limit = 20) => Api.forecastingApi(`/v1/forecasting/jobs?org_unit_id=${orgUnitId}&limit=${limit}`);

/* Synchronous — can take up to ~2 minutes (SARIMA/Prophet SLO per
   models.py's own doc comment). Needed when a forecast job comes back
   `status: queued`: no active model exists yet for that org unit and
   nothing auto-trains one (a stated, real backend gap, not a UI bug). */
export const retrainModels = (orgUnitId) => Api.forecastingApi(`/v1/forecasting/models/${orgUnitId}/retrain`, { method: 'POST', body: {} });

/* ---------- Goals & Requirements (service level targets) ---------- */
export const getServiceLevelTarget = (orgUnitId) => Api.forecastingApi(`/v1/forecasting/service-level-targets/${orgUnitId}`);
export const putServiceLevelTarget = (orgUnitId, body) =>
  Api.forecastingApi(`/v1/forecasting/service-level-targets/${orgUnitId}`, { method: 'PUT', body });

/* ---------- Allocations ---------- */
export const getAllocations = (orgUnitId) => Api.forecastingApi(`/v1/forecasting/allocations/${orgUnitId}`);
export const putAllocations = (orgUnitId, allocations) =>
  Api.forecastingApi(`/v1/forecasting/allocations/${orgUnitId}`, { method: 'PUT', body: { allocations } });

/* ---------- Backlog Age Template ---------- */
export const listBacklogAgeTemplates = () => Api.forecastingApi('/v1/forecasting/backlog-age-templates');
export const createBacklogAgeTemplate = (body) => Api.forecastingApi('/v1/forecasting/backlog-age-templates', { method: 'POST', body });
export const updateBacklogAgeTemplate = (id, body) => Api.forecastingApi(`/v1/forecasting/backlog-age-templates/${id}`, { method: 'PATCH', body });
export const deleteBacklogAgeTemplate = (id) => Api.forecastingApi(`/v1/forecasting/backlog-age-templates/${id}`, { method: 'DELETE' });

/* ---------- Backlog Age (snapshots) ---------- */
export const listBacklogSnapshots = (orgUnitId, limit = 50) =>
  Api.forecastingApi(`/v1/forecasting/backlog-snapshots?org_unit_id=${orgUnitId}&limit=${limit}`);
export const recordBacklogSnapshot = (body) => Api.forecastingApi('/v1/forecasting/backlog-snapshots', { method: 'POST', body });

/* ---------- Queue Analytics ---------- */
export const getQueueAnalytics = (orgUnitId) => Api.forecastingApi(`/v1/forecasting/queue-analytics/${orgUnitId}`);
