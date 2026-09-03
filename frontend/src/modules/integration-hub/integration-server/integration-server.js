/* Integration Server → Integration Servers. UNSUPPORTED, disclosed rather
   than faked: an on-prem managed Java server registry (RMI port, package
   deployment/refresh-cache) is a legacy telephony-hardware-era WFM concept
   with no analog in this SaaS architecture — connectors, Vault-backed
   credentials, and provider adapters already fill that role (see Data
   Sources → Settings). Building a fake server table here would violate
   the "never fake a capability" rule directly, so this screen states the
   gap plainly instead. */
import { pageHead, sec, gap } from '../../identity-org/shared/ui.js';

export function render() {
  return `
    ${pageHead('Integration Servers', 'On-prem integration server registry.', '')}
    ${sec('Integration Servers', `
      <div class="empty">
        <h2>${gap('Not applicable to this SaaS architecture.')}</h2>
        <p>This platform has no on-prem managed-server registry (RMI port, package deployment/refresh-cache) — that role is filled by <b>Data Sources → Settings</b> (tenant connectors, Vault-backed credentials, provider adapters) and, for on-prem ACD bridging, the <span class="mono">acd-onprem-collector</span> agent your network team deploys directly. Nothing here is faked or hard-coded — there is genuinely no backend concept to display.</p>
      </div>
    `)}`;
}

export function handle() {
  return false;
}
