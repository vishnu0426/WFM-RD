import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';

dotenv.config();

/**
 * First end-to-end (HTTP + GraphQL, real Postgres) test in this repo -
 * requires both migrations already applied. Boots the actual `AppModule`
 * (same wiring `main.ts` uses) and drives it exactly as an external caller
 * would: over HTTP, with `X-Tenant-Id` playing the role a validated JWT will
 * once Module 01 ships one (ADR-0014).
 */
describe('Org API (REST + GraphQL, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Org API Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('rejects a request with no X-Tenant-Id header (REST) with a stable error envelope', async () => {
    const res = await request(app.getHttpServer()).get(`/v1/org-units/${uuidv4()}/tree`).expect(400);
    expect(res.body.error.code).toBe('TENANT_CONTEXT_MISSING');
  });

  it('creates an org unit via GraphQL, reads it back via orgUnit(id), and its tree via REST', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({
        query: `
          mutation CreateRoot($input: CreateOrgUnitInput!) {
            createOrgUnit(input: $input) { id name type status }
          }
        `,
        variables: {
          input: { type: 'BUSINESS_UNIT', name: 'HTTP Test Root', timezone: 'UTC', countryCode: 'US' },
        },
      })
      .expect(200);

    expect(createRes.body.errors).toBeUndefined();
    const rootId = createRes.body.data.createOrgUnit.id;
    expect(createRes.body.data.createOrgUnit.name).toBe('HTTP Test Root');

    const readRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({ query: `query { orgUnit(id: "${rootId}") { id name status } }` })
      .expect(200);
    expect(readRes.body.data.orgUnit.name).toBe('HTTP Test Root');

    const treeRes = await request(app.getHttpServer())
      .get(`/v1/org-units/${rootId}/tree`)
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(treeRes.body.id).toBe(rootId);
    expect(treeRes.body.children).toEqual([]);
  });

  it("an org unit created under one tenant is invisible to another tenant's GraphQL query (TenantScopedRepository guard, end to end over HTTP)", async () => {
    // This exercises the application-layer guard (ADR-0002), which filters
    // by tenantId explicitly regardless of which DB role the app connects
    // as - it holds even when run against a superuser connection that would
    // itself bypass RLS. RLS-as-last-line-of-defense (a role that bypasses
    // the app-layer guard entirely) is covered by the raw-client tests in
    // rls-isolation.spec.ts / org-rls-isolation.spec.ts, not here.
    const otherTenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Org API Other Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );

    const createRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({
        query: `mutation($input: CreateOrgUnitInput!) { createOrgUnit(input: $input) { id } }`,
        variables: { input: { type: 'BUSINESS_UNIT', name: 'Tenant-scoped node', timezone: 'UTC', countryCode: 'US' } },
      })
      .expect(200);
    const orgUnitId = createRes.body.data.createOrgUnit.id;

    const crossTenantRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', otherTenant.id)
      .send({ query: `query { orgUnit(id: "${orgUnitId}") { id } }` })
      .expect(200);
    expect(crossTenantRes.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('builds a multi-level tree with employees attached (REST GET /v1/org-units/{id}/tree)', async () => {
    const orgUnitsRepo = migratorDataSource.getRepository(OrgUnit);
    // set_config here is session-level (false), matching the fix in
    // rls-isolation.spec.ts - this connection issues two statements and
    // needs the GUC to survive both.
    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const root = await orgUnitsRepo.save(
      orgUnitsRepo.create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.BUSINESS_UNIT,
        name: 'Multi-level Root',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    const child = await orgUnitsRepo.save(
      orgUnitsRepo.create({
        tenantId,
        parentOrgUnitId: root.id,
        type: OrgUnitType.DEPARTMENT,
        name: 'Multi-level Child',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );

    const treeRes = await request(app.getHttpServer())
      .get(`/v1/org-units/${root.id}/tree`)
      .set('x-tenant-id', tenantId)
      .expect(200);

    expect(treeRes.body.id).toBe(root.id);
    expect(treeRes.body.children).toHaveLength(1);
    expect(treeRes.body.children[0].id).toBe(child.id);
  });

  it('updateOrgUnit renames a node and REST as_of reconstructs the pre-rename state (ADR-0013)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({
        query: `mutation($input: CreateOrgUnitInput!) { createOrgUnit(input: $input) { id name } }`,
        variables: { input: { type: 'TEAM', name: 'Original Name', timezone: 'UTC', countryCode: 'US' } },
      })
      .expect(200);
    const id = createRes.body.data.createOrgUnit.id;

    // Postgres's own clock, not the test runner's - the two can be
    // meaningfully skewed when the DB is a separate host (observed ~600ms
    // here), which a Node-side `new Date()` + a short sleep can't reliably
    // stay ahead of. `org.fn_org_unit_history_track` (Phase 1) stamps
    // valid_from/valid_to with Postgres's `now()`, so the as-of boundary
    // has to be read from the same clock it's compared against.
    const beforeRenameRow = await migratorDataSource.query('SELECT now() AS now');
    const beforeRename: Date = beforeRenameRow[0].now;
    await new Promise((resolve) => setTimeout(resolve, 50));

    await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({
        query: `mutation($id: ID!, $input: UpdateOrgUnitInput!) { updateOrgUnit(id: $id, input: $input) { id name } }`,
        variables: { id, input: { name: 'Renamed' } },
      })
      .expect(200);

    const currentRes = await request(app.getHttpServer())
      .get(`/v1/org-units/${id}/tree`)
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(currentRes.body.name).toBe('Renamed');

    const asOfRes = await request(app.getHttpServer())
      .get(`/v1/org-units/${id}/tree`)
      .query({ as_of: beforeRename.toISOString() })
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(asOfRes.body.name).toBe('Original Name');
  });

  it('returns a 404 REST error and a NOT_FOUND GraphQL extension for a nonexistent org unit', async () => {
    const missingId = uuidv4();
    const restRes = await request(app.getHttpServer())
      .get(`/v1/org-units/${missingId}/tree`)
      .set('x-tenant-id', tenantId)
      .expect(404);
    expect(restRes.body.error.code).toBe('NOT_FOUND');

    const gqlRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({ query: `query { orgUnit(id: "${missingId}") { id } }` })
      .expect(200);
    expect(gqlRes.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});
