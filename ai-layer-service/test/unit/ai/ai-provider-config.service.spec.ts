import { randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AiProviderCredentialCipherService } from '../../../src/ai/security/ai-provider-credential-cipher.service';
import { AiProviderConfigInvalidError } from '../../../src/ai/errors/ai-provider-config-invalid.error';
import { AiProviderNotConfiguredError } from '../../../src/ai/errors/ai-provider-not-configured.error';
import { OllamaUnreachableError } from '../../../src/ai/errors/ollama-unreachable.error';
import { OllamaReachabilityChecker } from '../../../src/ai/ollama-reachability-checker';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

/** A fake DataSource/EntityManager holding at most one row, mirroring `AiProviderConfig`'s own one-row-per-tenant shape - own copy of every other spec's own `buildDataSource`. */
function buildDataSource(historyRows: Record<string, unknown>[] = []): {
  dataSource: DataSource;
  store: { row?: Record<string, unknown> };
  queryBuilder: Record<string, jest.Mock>;
} {
  const store: { row?: Record<string, unknown> } = {};
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(historyRows),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(() => Promise.resolve(store.row ?? null)),
    create: jest.fn((_entityClass: unknown, entity: Record<string, unknown>) => entity),
    save: jest.fn((_entityClass: unknown, entity: Record<string, unknown>) => {
      store.row = entity;
      return Promise.resolve(entity);
    }),
    getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;
  return { dataSource, store, queryBuilder };
}

describe('AiProviderConfigService', () => {
  const encryptionKey = randomBytes(32).toString('hex');

  function buildService(
    dataSource: DataSource,
    reachabilityChecker?: OllamaReachabilityChecker,
  ): AiProviderConfigService {
    const cipher = new AiProviderCredentialCipherService({ getOrThrow: () => encryptionKey } as never);
    const checker =
      reachabilityChecker ??
      ({ check: jest.fn().mockResolvedValue({ reachable: true }) } as unknown as OllamaReachabilityChecker);
    return new AiProviderConfigService(dataSource, cipher, checker);
  }

  it('rejects a cloud provider (anthropic/openai/gemini) with no apiKey', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.configure(TENANT_A, AiLlmProvider.ANTHROPIC, 'claude-x', null, null, null)).rejects.toThrow(
      AiProviderConfigInvalidError,
    );
    await expect(service.configure(TENANT_A, AiLlmProvider.OPENAI, 'gpt-x', null, null, null)).rejects.toThrow(
      AiProviderConfigInvalidError,
    );
    await expect(service.configure(TENANT_A, AiLlmProvider.GEMINI, 'gemini-x', null, null, null)).rejects.toThrow(
      AiProviderConfigInvalidError,
    );
  });

  it('rejects ollama with no baseUrl, even if an apiKey is supplied', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.configure(TENANT_A, AiLlmProvider.OLLAMA, 'llama3', 'some-key', null, null)).rejects.toThrow(
      AiProviderConfigInvalidError,
    );
  });

  it('accepts ollama with a baseUrl and no apiKey (the common self-hosted, unauthenticated case)', async () => {
    const { dataSource, store } = buildDataSource();
    const service = buildService(dataSource);

    const summary = await service.configure(
      TENANT_A,
      AiLlmProvider.OLLAMA,
      'llama3',
      null,
      'http://tenant-ollama.internal:11434',
      null,
    );

    expect(summary).toEqual({
      provider: AiLlmProvider.OLLAMA,
      model: 'llama3',
      baseUrl: 'http://tenant-ollama.internal:11434',
      updatedAt: expect.any(Date),
    });
    expect(store.row?.encryptedApiKey).toBeNull();
  });

  it('rejects ollama with a malformed baseUrl before ever calling the reachability checker', async () => {
    const { dataSource } = buildDataSource();
    const checker = { check: jest.fn() } as unknown as OllamaReachabilityChecker;
    const service = buildService(dataSource, checker);

    await expect(service.configure(TENANT_A, AiLlmProvider.OLLAMA, 'llama3', null, 'not-a-url', null)).rejects.toThrow(
      AiProviderConfigInvalidError,
    );
    expect(checker.check).not.toHaveBeenCalled();
  });

  it('rejects ollama with a non-http(s) baseUrl scheme', async () => {
    const { dataSource } = buildDataSource();
    const checker = { check: jest.fn() } as unknown as OllamaReachabilityChecker;
    const service = buildService(dataSource, checker);

    await expect(
      service.configure(TENANT_A, AiLlmProvider.OLLAMA, 'llama3', null, 'ftp://tenant-ollama.internal', null),
    ).rejects.toThrow(AiProviderConfigInvalidError);
    expect(checker.check).not.toHaveBeenCalled();
  });

  it('rejects ollama when the reachability check reports the baseUrl unreachable, and never persists anything', async () => {
    const { dataSource, store } = buildDataSource();
    const checker = {
      check: jest.fn().mockResolvedValue({ reachable: false, error: 'connect ECONNREFUSED' }),
    } as unknown as OllamaReachabilityChecker;
    const service = buildService(dataSource, checker);

    await expect(
      service.configure(TENANT_A, AiLlmProvider.OLLAMA, 'llama3', null, 'http://unreachable-host:11434', null),
    ).rejects.toThrow(OllamaUnreachableError);
    expect(store.row).toBeUndefined();
  });

  it('checks reachability against the exact tenant-supplied baseUrl', async () => {
    const { dataSource } = buildDataSource();
    const checker = { check: jest.fn().mockResolvedValue({ reachable: true }) } as unknown as OllamaReachabilityChecker;
    const service = buildService(dataSource, checker);

    await service.configure(
      TENANT_A,
      AiLlmProvider.OLLAMA,
      'llama3',
      null,
      'http://tenant-ollama.internal:11434',
      null,
    );

    expect(checker.check).toHaveBeenCalledWith('http://tenant-ollama.internal:11434');
  });

  it('never runs the reachability check for a cloud provider', async () => {
    const { dataSource } = buildDataSource();
    const checker = { check: jest.fn() } as unknown as OllamaReachabilityChecker;
    const service = buildService(dataSource, checker);

    await service.configure(TENANT_A, AiLlmProvider.ANTHROPIC, 'claude-x', 'sk-real', null, null);

    expect(checker.check).not.toHaveBeenCalled();
  });

  it('accepts a cloud provider with a real apiKey and never persists it in plaintext', async () => {
    const { dataSource, store } = buildDataSource();
    const service = buildService(dataSource);

    await service.configure(TENANT_A, AiLlmProvider.GEMINI, 'gemini-2.0-flash', 'gm-real-key', null, null);

    expect(store.row?.encryptedApiKey).not.toBe('gm-real-key');
    expect(store.row?.encryptedApiKey).toEqual(expect.any(String));
    expect(store.row?.baseUrl).toBeNull();
  });

  it('resolveForCall decrypts a real apiKey for a cloud provider', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);
    await service.configure(TENANT_A, AiLlmProvider.ANTHROPIC, 'claude-x', 'sk-ant-real', null, null);

    const resolved = await service.resolveForCall(TENANT_A);

    expect(resolved).toEqual({
      provider: AiLlmProvider.ANTHROPIC,
      model: 'claude-x',
      apiKey: 'sk-ant-real',
      baseUrl: null,
    });
  });

  it('resolveForCall returns a null apiKey for an unauthenticated ollama config', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);
    await service.configure(
      TENANT_A,
      AiLlmProvider.OLLAMA,
      'llama3',
      null,
      'http://tenant-ollama.internal:11434',
      null,
    );

    const resolved = await service.resolveForCall(TENANT_A);

    expect(resolved).toEqual({
      provider: AiLlmProvider.OLLAMA,
      model: 'llama3',
      apiKey: null,
      baseUrl: 'http://tenant-ollama.internal:11434',
    });
  });

  it('resolveForCall throws AiProviderNotConfiguredError when the tenant has never configured a provider', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.resolveForCall(TENANT_A)).rejects.toThrow(AiProviderNotConfiguredError);
  });

  it('getSummary echoes baseUrl back (not a secret) but never the key', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);
    await service.configure(
      TENANT_A,
      AiLlmProvider.OLLAMA,
      'llama3',
      null,
      'http://tenant-ollama.internal:11434',
      null,
    );

    const summary = await service.getSummary(TENANT_A);

    expect(summary).toEqual({
      provider: AiLlmProvider.OLLAMA,
      model: 'llama3',
      baseUrl: 'http://tenant-ollama.internal:11434',
      updatedAt: expect.any(Date),
    });
    expect(summary).not.toHaveProperty('apiKey');
    expect(summary).not.toHaveProperty('encryptedApiKey');
  });

  it('switching an existing tenant from ollama to a cloud provider upserts the row and clears baseUrl', async () => {
    const { dataSource, store } = buildDataSource();
    const service = buildService(dataSource);
    await service.configure(
      TENANT_A,
      AiLlmProvider.OLLAMA,
      'llama3',
      null,
      'http://tenant-ollama.internal:11434',
      null,
    );

    await service.configure(TENANT_A, AiLlmProvider.OPENAI, 'gpt-4', 'sk-oai-real', null, null);

    expect(store.row?.provider).toBe(AiLlmProvider.OPENAI);
    expect(store.row?.baseUrl).toBeNull();
    expect(store.row?.encryptedApiKey).toEqual(expect.any(String));
  });

  it('getHistory returns an empty array when the tenant has never configured a provider at all (no config row to key history off of)', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.getHistory(TENANT_A);

    expect(result).toEqual([]);
  });

  it("returns the history repository rows, newest-first, scoped to the tenant's own provider_config_id", async () => {
    const historyRow = {
      provider: AiLlmProvider.OLLAMA,
      model: 'llama3',
      baseUrl: 'http://x:11434',
      validFrom: new Date(),
      validTo: null,
      updatedBy: null,
    };
    const { dataSource, queryBuilder } = buildDataSource([historyRow]);
    const service = buildService(dataSource);
    await service.configure(TENANT_A, AiLlmProvider.OLLAMA, 'llama3', null, 'http://x:11434', null);

    const result = await service.getHistory(TENANT_A);

    expect(result).toEqual([historyRow]);
    expect(queryBuilder.where).toHaveBeenCalledWith('h.tenant_id = :tenantId', { tenantId: TENANT_A });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('h.valid_from', 'DESC');
  });

  it('getHistory never returns an encryptedApiKey field - the history rows structurally cannot carry the key at all', async () => {
    const historyRow = {
      provider: AiLlmProvider.ANTHROPIC,
      model: 'claude-x',
      baseUrl: null,
      validFrom: new Date(),
      validTo: null,
      updatedBy: null,
    };
    const { dataSource } = buildDataSource([historyRow]);
    const service = buildService(dataSource);
    await service.configure(TENANT_A, AiLlmProvider.ANTHROPIC, 'claude-x', 'sk-real-key', null, null);

    const result = await service.getHistory(TENANT_A);

    expect(result[0]).not.toHaveProperty('encryptedApiKey');
    expect(result[0]).not.toHaveProperty('apiKey');
  });
});
