import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { withTenantConnection } from '../database/with-tenant-connection';
import { EmployeeGrpcClientService } from '../grpc/employee-grpc-client.service';

/**
 * `GET /v1/leave/requests` (Attendance & Leave Manager Views phase) - the
 * manager approval queue's list endpoint, this service's first per-org-unit
 * (rather than per-employee or tenant-wide) `LeaveRequest` read. Resolves
 * `orgUnitId` to a roster via gRPC first, then filters locally by
 * `employee_id` - same two-step shape
 * `adherence-compliance-service`'s `ComplianceReportService` already uses
 * for the identical problem (this service owning no local org-unit data at
 * all). `ORDER BY requested_at DESC` matches
 * `idx_leave_request_tenant_status_requested_at`'s own column order.
 */
@Injectable()
export class ListLeaveRequestsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
  ) {}

  async listForOrgUnit(
    tenantId: string,
    orgUnitId: string,
    status: LeaveRequestStatus,
    limit: number,
    offset: number,
  ): Promise<LeaveRequest[]> {
    const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, orgUnitId);
    if (roster.length === 0) {
      return [];
    }
    const employeeIds = roster.map((e) => e.employeeId);

    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .createQueryBuilder(LeaveRequest, 'request')
        .where('request.tenantId = :tenantId', { tenantId })
        .andWhere('request.employeeId IN (:...employeeIds)', { employeeIds })
        .andWhere('request.status = :status', { status })
        .orderBy('request.requestedAt', 'DESC')
        .take(limit)
        .skip(offset)
        .getMany(),
    );
  }
}
