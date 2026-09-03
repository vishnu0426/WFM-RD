import { Injectable } from '@nestjs/common';

const REACHABILITY_CHECK_TIMEOUT_MS = 5_000;

export interface OllamaReachabilityResult {
  reachable: boolean;
  error?: string;
}

/**
 * Phase 9 (docs/adr/0129/0133): a real, if narrow, closure of ADR-0129's
 * own disclosed gap ("this platform never validates or tunnels to a
 * tenant's self-hosted Ollama instance"). `GET {baseUrl}/api/tags` is
 * Ollama's own stable, unauthenticated "list local models" endpoint - part
 * of its core REST API since the project's earliest versions - used purely
 * as a reachability probe, its actual response body is never read.
 *
 * This validates reachability **at configuration time only**, from this
 * service's own network vantage point - not a standing guarantee. A
 * firewall rule change, the tenant's instance going down, or a network
 * path that differs between "when this check ran" and "when a real LLM
 * call later runs" would not be caught here. `configure`-time rejection is
 * still valuable: it turns "silently broken until the first real call
 * fails" into an immediate, actionable error at the moment of
 * misconfiguration (a wrong host, a typo, an unreachable network) -
 * exactly when a tenant can most easily fix it.
 */
@Injectable()
export class OllamaReachabilityChecker {
  async check(baseUrl: string): Promise<OllamaReachabilityResult> {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REACHABILITY_CHECK_TIMEOUT_MS) });
      if (!response.ok) {
        return { reachable: false, error: `HTTP ${response.status}` };
      }
      return { reachable: true };
    } catch (err) {
      return { reachable: false, error: (err as Error).message };
    }
  }
}
