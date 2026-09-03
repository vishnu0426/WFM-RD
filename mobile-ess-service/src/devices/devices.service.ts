import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../database/postgres-error-codes';
import { withTenantConnection } from '../database/with-tenant-connection';
import { RegisterDeviceRequestDto } from './dto/register-device-request.dto';
import { DeviceRegistration } from './entities/device-registration.entity';

/**
 * `POST /v1/mobile/devices` (ADR-0154). Upsert keyed on the entity's own
 * `(tenant_id, employee_id, device_type, device_id)` UNIQUE constraint
 * (ADR-0150/ADR-0157, Module 11 Gap 2 - widened from `(tenant_id,
 * employee_id, device_type)` so two devices of the same employee/platform
 * get independent rows) - every call (fresh registration or a repeat call
 * on every app boot, `useRegisterDeviceOnAuth`) is one idempotent write, no
 * separate heartbeat endpoint. `active` is force-set `true` on every upsert
 * so a reinstall/token-refresh revives a device `PushDispatchService`
 * previously marked dead (`markInactive`).
 *
 * Mirrors `MobileSyncService.processAction`'s own find-then-write +
 * unique-violation-retry shape (this service's established convention for
 * a race between two concurrent writes for the same key), not the raw
 * `INSERT ... ON CONFLICT` style other services use - this service has no
 * precedent for that, and a plain repository round-trip keeps this
 * endpoint's low write volume (once per app boot) consistent with the
 * rest of this codebase.
 *
 * GAP-16 fix (enterprise readiness audit, 2026-08-18): every query now goes
 * through `withTenantConnection` - see that helper's own doc comment for
 * why a plain injected `Repository` against this RLS-enabled table was a
 * real, previously-undetected bug (every read returned zero rows, every
 * write was rejected), not just a missing defense-in-depth layer.
 */
@Injectable()
export class DevicesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async register(tenantId: string, dto: RegisterDeviceRequestDto): Promise<DeviceRegistration> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repo = manager.getRepository(DeviceRegistration);
      const existing = await repo.findOne({
        where: { tenantId, employeeId: dto.employeeId, deviceType: dto.deviceType, deviceId: dto.deviceId },
      });

      if (existing) {
        return repo.save({
          ...existing,
          pushToken: dto.pushToken,
          appVersion: dto.appVersion,
          biometricEnrolled: dto.biometricEnrolled,
          active: true,
          lastActiveAt: new Date(),
        });
      }

      try {
        return await repo.save(
          repo.create({
            tenantId,
            employeeId: dto.employeeId,
            deviceType: dto.deviceType,
            deviceId: dto.deviceId,
            pushToken: dto.pushToken,
            appVersion: dto.appVersion,
            biometricEnrolled: dto.biometricEnrolled,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date(),
          }),
        );
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw err;
        }
        // A genuinely concurrent registerDevice call for this same
        // (tenant, employee, deviceType, deviceId) beat us to the insert
        // (e.g. two app-boot registrations firing at once) - reload and
        // apply this call's values on top, same race-recovery shape
        // MobileSyncService.processAction already uses.
        const row = await repo.findOneOrFail({
          where: { tenantId, employeeId: dto.employeeId, deviceType: dto.deviceType, deviceId: dto.deviceId },
        });
        return repo.save({
          ...row,
          pushToken: dto.pushToken,
          appVersion: dto.appVersion,
          biometricEnrolled: dto.biometricEnrolled,
          active: true,
          lastActiveAt: new Date(),
        });
      }
    });
  }

  /** Only registered/active devices are ever push-dispatch targets - a
   * dead token (ADR-0154 §6) stops being targeted on the very next event
   * with no separate reaper job. */
  async findActiveForEmployee(tenantId: string, employeeId: string): Promise<DeviceRegistration[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(DeviceRegistration).find({ where: { tenantId, employeeId, active: true } }),
    );
  }

  async markInactive(tenantId: string, id: string): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(DeviceRegistration).update({ id }, { active: false }),
    );
  }
}
