import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AttendanceRecord } from './entities/attendance-record.entity';
import { withTenantConnection } from '../database/with-tenant-connection';

/**
 * Module 11 Phase 7 (docs/adr/0156): the mobile self-service Hours tab's
 * "worked hours" data source - this service's first per-employee read of
 * `AttendanceRecord` (every prior read path is supervisor/tenant-wide,
 * e.g. `ListAbsencePatternsService`). Returns raw rows, not a
 * pre-summed total - see the controller's own doc comment for why hours
 * summation is a client concern, not this endpoint's.
 */
@Injectable()
export class ListEmployeeAttendanceRecordsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listForEmployee(tenantId: string, employeeId: string, from: Date, to: Date): Promise<AttendanceRecord[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .createQueryBuilder(AttendanceRecord, 'record')
        .where('record.tenantId = :tenantId', { tenantId })
        .andWhere('record.employeeId = :employeeId', { employeeId })
        .andWhere('record.clockInAt >= :from', { from })
        .andWhere('record.clockInAt < :to', { to })
        .orderBy('record.clockInAt', 'DESC')
        .getMany(),
    );
  }
}
