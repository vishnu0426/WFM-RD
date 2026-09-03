import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
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
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { SigningKeysRepository } from '../../src/modules/auth/repositories/signing-keys.repository';
import { TokenService } from '../../src/modules/auth/services/token.service';

dotenv.config();

const AVATAR_DIR = path.join(process.cwd(), 'uploads', 'avatars');

/**
 * `POST /v1/employees/:id/avatar` end to end - real Postgres, real
 * `multipart/form-data` upload via supertest's `.attach()`, real file
 * landing on disk. Bootstrap mirrors `employee-api-http.spec.ts` (JWT-gated
 * REST/GraphQL, same tenant/org-unit/token setup) since this controller
 * sits behind the same `AccessTokenGuard`+`PermissionsGuard` pair.
 */
describe('Employee Avatar Upload (REST, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let orgUnitId: string;
  let accessToken: string;
  const writtenFiles: string[] = [];

  const gql = (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ query, variables });

  const restHeaders = () => ({ 'x-tenant-id': tenantId, Authorization: `Bearer ${accessToken}` });

  async function createEmployee(): Promise<string> {
    const res = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-01-15',
      },
    });
    return res.body.data.createEmployee.id;
  }

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
        name: `Employee Avatar Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const orgUnitsRepo = migratorDataSource.getRepository(OrgUnit);
    const orgUnit = await orgUnitsRepo.save(
      orgUnitsRepo.create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Avatar Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitId = orgUnit.id;

    const signingKeyService = new SigningKeyService(new SigningKeysRepository(migratorDataSource));
    await signingKeyService.onModuleInit();
    const tokenService = new TokenService(signingKeyService, {
      get: (key: string, fallback?: string) =>
        ({ OIDC_ISSUER: 'https://auth.agno-wfm.local', OIDC_AUDIENCE: 'agno-core-api' })[key] ?? fallback,
    } as never);
    const { token } = await tokenService.issueAccessToken({
      userId: uuidv4(),
      tenantId,
      orgUnitId: null,
      roles: ['tenant_admin'],
      permissions: ['employee:read', 'employee:write'],
      amr: ['pwd'],
      authTime: new Date(),
    });
    accessToken = token;
  });

  afterAll(async () => {
    // Clean up every file this suite actually wrote to the shared
    // uploads/avatars/ directory, so repeated runs don't accumulate test
    // artifacts there.
    for (const filePath of writtenFiles) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    await app.close();
    await migratorDataSource.destroy();
  });

  it('uploads a real PNG, forces the filename to <employeeId>.png, writes it to disk, and persists avatarUrl', async () => {
    const employeeId = await createEmployee();
    const expectedPath = path.join(AVATAR_DIR, `${employeeId}.png`);
    writtenFiles.push(expectedPath);

    const uploadRes = await request(app.getHttpServer())
      .post(`/v1/employees/${employeeId}/avatar`)
      .set(restHeaders())
      .attach('file', Buffer.from('not-really-a-png-but-fileFilter-only-checks-mimetype'), {
        filename: 'my-original-photo-name.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(uploadRes.body).toEqual({ avatarUrl: `/uploads/avatars/${employeeId}.png` });
    expect(fs.existsSync(expectedPath)).toBe(true);

    const readRes = await gql(`query { employee(id: "${employeeId}") { avatarUrl } }`).expect(200);
    expect(readRes.body.data.employee.avatarUrl).toBe(`/uploads/avatars/${employeeId}.png`);
  });

  it('derives the extension from the mimetype, ignoring a spoofed original filename extension', async () => {
    const employeeId = await createEmployee();
    const expectedPath = path.join(AVATAR_DIR, `${employeeId}.webp`);
    writtenFiles.push(expectedPath);

    const uploadRes = await request(app.getHttpServer())
      .post(`/v1/employees/${employeeId}/avatar`)
      .set(restHeaders())
      .attach('file', Buffer.from('webp-bytes'), { filename: 'trick.exe', contentType: 'image/webp' })
      .expect(201);

    expect(uploadRes.body.avatarUrl).toBe(`/uploads/avatars/${employeeId}.webp`);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('rejects a disallowed mimetype with a 400 INVALID_AVATAR_FILE envelope, and writes nothing to disk', async () => {
    const employeeId = await createEmployee();

    const res = await request(app.getHttpServer())
      .post(`/v1/employees/${employeeId}/avatar`)
      .set(restHeaders())
      .attach('file', Buffer.from('not an image'), { filename: 'evil.sh', contentType: 'application/x-sh' })
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_AVATAR_FILE');
    for (const ext of ['.png', '.jpg', '.webp']) {
      expect(fs.existsSync(path.join(AVATAR_DIR, `${employeeId}${ext}`))).toBe(false);
    }
  });

  it('returns a 404 NOT_FOUND envelope for an unknown employee id', async () => {
    const unknownId = uuidv4();
    const expectedPath = path.join(AVATAR_DIR, `${unknownId}.png`);
    writtenFiles.push(expectedPath); // multer writes before the controller's own not-found check runs

    const res = await request(app.getHttpServer())
      .post(`/v1/employees/${unknownId}/avatar`)
      .set(restHeaders())
      .attach('file', Buffer.from('irrelevant'), { filename: 'photo.png', contentType: 'image/png' })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a request with no access token at all', async () => {
    const employeeId = await createEmployee();
    await request(app.getHttpServer())
      .post(`/v1/employees/${employeeId}/avatar`)
      .set('x-tenant-id', tenantId)
      .attach('file', Buffer.from('irrelevant'), { filename: 'photo.png', contentType: 'image/png' })
      .expect(401);
  });
});
