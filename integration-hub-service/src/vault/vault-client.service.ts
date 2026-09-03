import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import vaultConfig from './vault.config';
import { VaultSecretNotFoundError, VaultUnavailableError } from './vault.errors';

interface VaultKvV2ReadResponse {
  data: { data: Record<string, unknown> | null } | null;
}

/**
 * Real HashiCorp Vault KV v2 HTTP client (ADR-0134, ADR-0137) - not a mock,
 * not an in-process stand-in. Every credential this module ever touches
 * (OAuth tokens, non-OAuth CMS/TSAPI credentials, tenant-supplied OAuth
 * client secrets) goes through exactly these three methods; nothing else in
 * this service is permitted to hold credential material outside the single
 * call that reads it here (§2.2 rule 1).
 *
 * §0.5's chaos-test posture: every method fails closed on any error
 * (network failure, non-2xx response, malformed body) - there is no
 * catch-and-fall-back-to-cached/default path anywhere in this class.
 * Verified live against a real local Vault dev-mode server
 * (`vault server -dev`) - see the Phase 2 design doc's verification
 * section for the actual read/write/delete/failure transcript.
 */
@Injectable()
export class VaultClientService {
  constructor(@Inject(vaultConfig.KEY) private readonly config: ConfigType<typeof vaultConfig>) {}

  async write(path: string, data: Record<string, unknown>): Promise<void> {
    const url = this.secretUrl('data', path);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ data }),
      });
    } catch (err) {
      throw new VaultUnavailableError('write', (err as Error).message);
    }
    if (!response.ok) {
      throw new VaultUnavailableError('write', `HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
  }

  async read(path: string): Promise<Record<string, unknown>> {
    const url = this.secretUrl('data', path);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.headers() });
    } catch (err) {
      throw new VaultUnavailableError('read', (err as Error).message);
    }
    if (response.status === 404) {
      throw new VaultSecretNotFoundError(path);
    }
    if (!response.ok) {
      throw new VaultUnavailableError('read', `HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
    let body: VaultKvV2ReadResponse;
    try {
      body = (await response.json()) as VaultKvV2ReadResponse;
    } catch (err) {
      throw new VaultUnavailableError('read', `malformed response body: ${(err as Error).message}`);
    }
    // A soft-deleted KV v2 version returns HTTP 200 with `data.data: null`,
    // not a 404 - both must fail closed identically from this client's
    // caller's point of view.
    if (!body.data?.data) {
      throw new VaultSecretNotFoundError(path);
    }
    return body.data.data;
  }

  async delete(path: string): Promise<void> {
    const url = this.secretUrl('metadata', path);
    let response: Response;
    try {
      response = await fetch(url, { method: 'DELETE', headers: this.headers() });
    } catch (err) {
      throw new VaultUnavailableError('delete', (err as Error).message);
    }
    // Vault returns 204 whether or not the path existed - deleting an
    // already-absent secret is not an error this client needs to surface.
    if (!response.ok && response.status !== 404) {
      throw new VaultUnavailableError('delete', `HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
  }

  private secretUrl(segment: 'data' | 'metadata', path: string): string {
    if (!this.config.addr || !this.config.token) {
      throw new VaultUnavailableError('configuration', 'VAULT_ADDR/VAULT_TOKEN are not set');
    }
    return `${this.config.addr}/v1/${this.config.kvMount}/${segment}/${path}`;
  }

  private headers(): Record<string, string> {
    return { 'X-Vault-Token': this.config.token, 'Content-Type': 'application/json' };
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable body>';
    }
  }
}
