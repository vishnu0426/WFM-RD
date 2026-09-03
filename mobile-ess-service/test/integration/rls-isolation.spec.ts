import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities, DeviceRegistration } from '../../src/database/entities';
import { DeviceType } from '../../src/devices/entities/device-registration.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `mobile_ess.*`'s RLS
 * policies (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` since this
 * service's very first migration) have never had a runtime proof of their
 * own - only the root service's 4 RLS-isolation specs exist. Writing this
 * test is what caught a real, previously-undetected P0: `DevicesService`/
 * `MobileSyncService` used a plain `@InjectRepository`-bound `Repository`
 * and never once called `set_config`, so every query against these tables
 * silently returned zero rows and every write was rejected outright by the
 * `WITH CHECK` clause the moment RLS was actually exercised - confirmed
 * with a bare `psql` `INSERT` as `agno_mobile_ess_app` before the fix (see
 * `with-tenant-connection.ts`'s own doc comment). Both services now route
 * every query through `withTenantConnection`, verified below.
 */
describe('mobile_ess.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_mobile_ess_app, same role the running application uses

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let deviceAId: string;
  let deviceBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_mobile_ess_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    const now = new Date();
    const deviceA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(DeviceRegistration).save({
        id: randomUUID(),
        tenantId: tenantAId,
        employeeId: randomUUID(),
        deviceType: DeviceType.IOS,
        deviceId: 'rls-test-install-a',
        pushToken: 'rls-test-token-a',
        appVersion: '1.0.0',
        biometricEnrolled: false,
        active: true,
        lastActiveAt: now,
        createdAt: now,
      } as DeviceRegistration),
    );
    const deviceB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(DeviceRegistration).save({
        id: randomUUID(),
        tenantId: tenantBId,
        employeeId: randomUUID(),
        deviceType: DeviceType.IOS,
        deviceId: 'rls-test-install-b',
        pushToken: 'rls-test-token-b',
        appVersion: '1.0.0',
        biometricEnrolled: false,
        active: true,
        lastActiveAt: now,
        createdAt: now,
      } as DeviceRegistration),
    );
    deviceAId = deviceA.id;
    deviceBId = deviceB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
  });

  it("a tenant's session only sees its own device registrations", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(DeviceRegistration).find({ where: { id: deviceAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(DeviceRegistration).find({ where: { id: deviceBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('a plain, unscoped INSERT (the pre-fix shape) is rejected outright by RLS, not silently miswritten', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_mobile_ess_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await expect(
        rawClient.query(
          `INSERT INTO mobile_ess.device_registration
             (tenant_id, employee_id, device_type, device_id, push_token, app_version, last_active_at, created_at)
           VALUES ($1, $2, 'ios', 'no-set-config', 'tok', '1.0.0', now(), now())`,
          [tenantAId, randomUUID()],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await rawClient.end();
    }
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_mobile_ess_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query(
        'SELECT id FROM mobile_ess.device_registration WHERE id = ANY($1::uuid[])',
        [[deviceAId, deviceBId]],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    const now = new Date();
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(DeviceRegistration).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          employeeId: randomUUID(),
          deviceType: DeviceType.IOS,
          deviceId: 'rls-test-mismatch',
          pushToken: 'rls-test-token',
          appVersion: '1.0.0',
          biometricEnrolled: false,
          active: true,
          lastActiveAt: now,
          createdAt: now,
        } as DeviceRegistration),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_mobile_ess_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_mobile_ess_app',
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
