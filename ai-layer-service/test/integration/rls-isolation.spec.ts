import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, AiInteraction } from '../../src/database/entities';
import { AiInteractionType } from '../../src/ai/entities/ai-interaction.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `ai_layer.*`'s RLS
 * policies have never had a runtime proof of their own - only the root
 * service's 4 RLS-isolation specs exist. Same "talk to Postgres directly,
 * bypassing the app guard entirely" posture as the root's own
 * `rls-isolation.spec.ts`.
 */
describe('ai_layer.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_ai_app, same role the running application uses

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let interactionAId: string;
  let interactionBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_ai_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    const now = new Date();
    const interactionA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AiInteraction).save({
        id: randomUUID(),
        tenantId: tenantAId,
        userId: null,
        interactionType: AiInteractionType.NL_QUERY,
        inputContext: {},
        outputText: 'rls test fixture',
        outputStructured: null,
        modelUsed: 'rls-test@prompt-v0',
        confidenceIndicator: '0.90',
        degradedMode: false,
        createdAt: now,
      } as AiInteraction),
    );
    const interactionB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(AiInteraction).save({
        id: randomUUID(),
        tenantId: tenantBId,
        userId: null,
        interactionType: AiInteractionType.NL_QUERY,
        inputContext: {},
        outputText: 'rls test fixture',
        outputStructured: null,
        modelUsed: 'rls-test@prompt-v0',
        confidenceIndicator: '0.90',
        degradedMode: false,
        createdAt: now,
      } as AiInteraction),
    );
    interactionAId = interactionA.id;
    interactionBId = interactionB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
  });

  it("a tenant's session only sees its own AI interactions", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AiInteraction).find({ where: { id: interactionAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AiInteraction).find({ where: { id: interactionBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_ai_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM ai_layer.ai_interaction WHERE id = ANY($1::uuid[])', [
        [interactionAId, interactionBId],
      ]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(AiInteraction).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          userId: null,
          interactionType: AiInteractionType.NL_QUERY,
          inputContext: {},
          outputText: 'rls test fixture',
          outputStructured: null,
          modelUsed: 'rls-test@prompt-v0',
          confidenceIndicator: '0.90',
          degradedMode: false,
          createdAt: new Date(),
        } as AiInteraction),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_ai_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_ai_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await expect(rawClient.query('SELECT 1 FROM core.users LIMIT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await rawClient.end();
    }
  });
});
