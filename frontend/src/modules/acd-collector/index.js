/* acd-onprem-collector — on-prem ACD data ingestion. Unlike the other 11
   services, it has no public HTTP API of its own to point a screen at (per
   repo-root RUN.md, it's not in the service port table) — it feeds data
   into the root service's Employee.agentId/extension/dataSource columns
   (see src/modules/employee/entities/employee.entity.ts on the backend),
   which the Profiles screen already surfaces under the "Workforce / Agent"
   tab. No separate screen belongs here. */
export function render() {
  return `<div class="page-head"><div><h1>ACD Collector</h1><p>No UI here by design — see this file's header comment.</p></div></div>`;
}

export function handle() {
  return false;
}
