import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { AttendanceRecord, AttendanceSource } from '../../src/attendance/entities/attendance-record.entity';
import { withTenantConnection } from '../../src/database/with-tenant-connection';

dotenv.config();

/**
 * GAP-16 (enterprise readiness audit, 2026-08-18): `attendance_leave.*`'s
 * RLS policies (InitialAttendanceLeaveSchema1700000600000) have never had a
 * runtime proof of their own - only the root service's 4 RLS-isolation
 * specs exist. Same "talk to Postgres directly, bypassing the app guard
 * entirely" posture as the root's own `rls-isolation.spec.ts`.
 */
describe('attendance_leave.* RLS isolation (GAP-16)', () => {
  let appDataSource: DataSource; // agno_attendance_leave_app, same role the running application uses

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  let recordAId: string;
  let recordBId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_attendance_leave_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    const recordA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AttendanceRecord).save({
        id: randomUUID(),
        tenantId: tenantAId,
        employeeId: randomUUID(),
        clockInAt: new Date(),
        clockOutAt: null,
        source: AttendanceSource.MANUAL,
        scheduledShiftId: null,
        exceptionType: null,
        exceptionMinutes: null,
        geofenceVerified: null,
      } as AttendanceRecord),
    );
    const recordB = await withTenantConnection(appDataSource, tenantBId, (manager) =>
      manager.getRepository(AttendanceRecord).save({
        id: randomUUID(),
        tenantId: tenantBId,
        employeeId: randomUUID(),
        clockInAt: new Date(),
        clockOutAt: null,
        source: AttendanceSource.MANUAL,
        scheduledShiftId: null,
        exceptionType: null,
        exceptionMinutes: null,
        geofenceVerified: null,
      } as AttendanceRecord),
    );
    recordAId = recordA.id;
    recordBId = recordB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
  });

  it("a tenant's session only sees its own attendance records", async () => {
    const seenByA = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AttendanceRecord).find({ where: { id: recordAId } }),
    );
    expect(seenByA).toHaveLength(1);

    const crossTenant = await withTenantConnection(appDataSource, tenantAId, (manager) =>
      manager.getRepository(AttendanceRecord).find({ where: { id: recordBId } }),
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_attendance_leave_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query(
        'SELECT id FROM attendance_leave.attendance_record WHERE id = ANY($1::uuid[])',
        [[recordAId, recordBId]],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('a write with a mismatched tenant_id is rejected by the WITH CHECK clause, not silently rescoped', async () => {
    await expect(
      withTenantConnection(appDataSource, tenantAId, (manager) =>
        manager.getRepository(AttendanceRecord).save({
          id: randomUUID(),
          tenantId: tenantBId, // mismatched on purpose
          employeeId: randomUUID(),
          clockInAt: new Date(),
          clockOutAt: null,
          source: AttendanceSource.MANUAL,
          scheduledShiftId: null,
          exceptionType: null,
          exceptionMinutes: null,
          geofenceVerified: null,
        } as AttendanceRecord),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('agno_attendance_leave_app cannot read core/org/forecasting schemas (no cross-schema grant)', async () => {
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_attendance_leave_app',
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
