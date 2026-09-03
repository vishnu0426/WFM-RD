import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiProviderConfig, AiLlmProvider } from './entities/ai-provider-config.entity';
import { AiProviderConfigHistory } from './entities/ai-provider-config-history.entity';
import { AiProviderCredentialCipherService } from './security/ai-provider-credential-cipher.service';
import { AiProviderNotConfiguredError } from './errors/ai-provider-not-configured.error';
import { AiProviderConfigInvalidError } from './errors/ai-provider-config-invalid.error';
import { OllamaUnreachableError } from './errors/ollama-unreachable.error';
import { OllamaReachabilityChecker } from './ollama-reachability-checker';
import { ResolvedLlmProvider } from './llm/llm-client';

type ConfigSummary = { provider: AiLlmProvider; model: string; baseUrl: string | null; updatedAt: Date };

/**
 * docs/adr/0117/0129: the tenant-facing half of BYOK provider configuration.
 * `configure` upserts (one row per tenant, `ai_provider_config_tenant_key`) -
 * a tenant rotating their key or switching provider/model calls this again,
 * it never needs a separate "update" mutation. `resolveForCall` is the only
 * path that ever decrypts a key, and its result is used immediately for one
 * `LlmClient.complete` call, never cached/held across requests.
 */
@Injectable()
export class AiProviderConfigService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cipher: AiProviderCredentialCipherService,
    private readonly ollamaReachability: OllamaReachabilityChecker,
  ) {}

  /**
   * docs/adr/0129: `ollama` is typically a tenant's own self-hosted,
   * unauthenticated instance - `baseUrl` (not `apiKey`) is what makes it
   * reachable at all. The three cloud providers keep requiring a real
   * `apiKey`, same as before this ADR.
   */
  private validate(provider: AiLlmProvider, apiKey: string | null, baseUrl: string | null): void {
    if (provider === AiLlmProvider.OLLAMA) {
      if (!baseUrl) {
        throw new AiProviderConfigInvalidError('baseUrl is required when provider is "ollama".');
      }
      // Phase 9 (docs/adr/0133): a cheap, immediate rejection of obviously
      // malformed input (a typo, a bare hostname with no scheme) before
      // ever reaching `OllamaReachabilityChecker`'s real network call - a
      // clearer error than whatever generic fetch failure a garbage URL
      // would otherwise produce.
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        throw new AiProviderConfigInvalidError(`baseUrl "${baseUrl}" is not a valid URL.`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiProviderConfigInvalidError(`baseUrl "${baseUrl}" must use http or https.`);
      }
      return;
    }
    if (!apiKey) {
      throw new AiProviderConfigInvalidError(`apiKey is required when provider is "${provider}".`);
    }
  }

  async configure(
    tenantId: string,
    provider: AiLlmProvider,
    model: string,
    apiKey: string | null,
    baseUrl: string | null,
    updatedBy: string | null,
  ): Promise<ConfigSummary> {
    this.validate(provider, apiKey, baseUrl);
    // docs/adr/0129/0133: a real, if narrow, closure of "this platform
    // never validates or tunnels to a tenant's self-hosted Ollama
    // instance" - validated at configuration time only, from this
    // service's own network vantage point, not a standing guarantee (see
    // OllamaReachabilityChecker's own doc comment).
    if (provider === AiLlmProvider.OLLAMA && baseUrl) {
      const reachability = await this.ollamaReachability.check(baseUrl);
      if (!reachability.reachable) {
        throw new OllamaUnreachableError(baseUrl, reachability.error ?? 'unknown error');
      }
    }
    const encryptedApiKey = apiKey ? this.cipher.encrypt(apiKey) : null;
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(AiProviderConfig, { where: { tenantId } });
      const now = new Date();
      if (existing) {
        existing.provider = provider;
        existing.model = model;
        existing.encryptedApiKey = encryptedApiKey;
        existing.baseUrl = baseUrl;
        existing.updatedAt = now;
        existing.updatedBy = updatedBy;
        const saved = await manager.save(AiProviderConfig, existing);
        return { provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl, updatedAt: saved.updatedAt };
      }
      const created = manager.create(AiProviderConfig, {
        id: randomUUID(),
        tenantId,
        provider,
        model,
        encryptedApiKey,
        baseUrl,
        createdAt: now,
        updatedAt: now,
        updatedBy,
      });
      const saved = await manager.save(AiProviderConfig, created);
      return { provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl, updatedAt: saved.updatedAt };
    });
  }

  /** Never returns the config row itself - only what a caller displaying "your current setup" needs, minus the key. `baseUrl` is not a secret (unlike the key), safe to echo back. */
  async getSummary(tenantId: string): Promise<ConfigSummary | null> {
    const config = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AiProviderConfig, { where: { tenantId } }),
    );
    return config
      ? { provider: config.provider, model: config.model, baseUrl: config.baseUrl, updatedAt: config.updatedAt }
      : null;
  }

  /** ADR-0132: newest-first version history (provider/model/baseUrl/updatedBy only - never the key, see the history entity's own doc comment). Empty if the tenant has never configured a provider at all. */
  async getHistory(tenantId: string): Promise<AiProviderConfigHistory[]> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const config = await manager.findOne(AiProviderConfig, { where: { tenantId } });
      if (!config) {
        return [];
      }
      return manager
        .getRepository(AiProviderConfigHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.provider_config_id = :providerConfigId', { providerConfigId: config.id })
        .orderBy('h.valid_from', 'DESC')
        .getMany();
    });
  }

  /** Decrypts and returns the tenant's live credentials for exactly one `LlmClient.complete` call - never cached. `apiKey` is `null` for an `ollama` config with none configured. */
  async resolveForCall(tenantId: string): Promise<ResolvedLlmProvider> {
    const config = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AiProviderConfig, { where: { tenantId } }),
    );
    if (!config) {
      throw new AiProviderNotConfiguredError(tenantId);
    }
    return {
      provider: config.provider,
      model: config.model,
      apiKey: config.encryptedApiKey ? this.cipher.decrypt(config.encryptedApiKey) : null,
      baseUrl: config.baseUrl,
    };
  }
}
