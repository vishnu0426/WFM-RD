import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AttendanceExceptionType, AttendanceRecord } from './entities/attendance-record.entity';
import { withTenantConnection } from '../database/with-tenant-connection';
import { EmployeeGrpcClientService } from '../grpc/employee-grpc-client.service';

/**
 * `GET /v1/attendance/exceptions` (Attendance & Leave Manager Views phase) -
 * this service's first tenant/org-unit-wide (rather than single-employee)
 * `AttendanceRecord` read. Same roster-first-then-filter shape
 * `ListLeaveRequestsService` uses. `exception_type IS NOT NULL` plus the
 * `clock_in_at` range is the filter shape the new partial index
 * (`AttendanceRecordExceptionTypeIndex` migration) targets.
 */
@Injectable()
export class ListAttendanceExceptionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
  ) {}

  async listForOrgUnit(
    tenantId: string,
    orgUnitId: string,
    dateFrom: Date,
    dateTo: Date,
    exceptionType: AttendanceExceptionType | undefined,
    limit: number,
    offset: number,
  ): Promise<AttendanceRecord[]> {
    const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, orgUnitId);
    if (roster.length === 0) {
      return [];
    }
    const employeeIds = roster.map((e) => e.employeeId);

    return withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .createQueryBuilder(AttendanceRecord, 'record')
        .where('record.tenantId = :tenantId', { tenantId })
        .andWhere('record.employeeId IN (:...employeeIds)', { employeeIds })
        .andWhere('record.exceptionType IS NOT NULL')
        .andWhere('record.clockInAt >= :dateFrom', { dateFrom })
        .andWhere('record.clockInAt <= :dateTo', { dateTo });

      if (exceptionType) {
        qb.andWhere('record.exceptionType = :exceptionType', { exceptionType });
      }

      return qb.orderBy('record.clockInAt', 'DESC').take(limit).skip(offset).getMany();
    });
  }
}
