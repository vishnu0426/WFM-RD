import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { withTenantConnection } from '../../database/with-tenant-connection';

interface GetUnavailabilityRequest {
  tenantId: string;
  employeeIds: string[];
  dateRangeStart: string;
  dateRangeEnd: string;
}

interface UnavailabilityRecord {
  employeeId: string;
  startDate: string;
  endDate: string;
  leaveTypeId: string;
}

/**
 * §3.4/ADR-0078: `LeaveService.GetUnavailability` - the pull direction
 * scheduling-service's own solve-input resolver calls mid-solve
 * (§4.3-style gRPC pull, ADR-0059's precedent). No HTTP middleware binds
 * tenant context on a gRPC call (ADR-0021, same as core's
 * `EmployeeGrpcController`) - bound explicitly per-handler from the
 * request message's own `tenant_id` field.
 *
 * §2.2 rule 2: only `status = 'approved'` rows are ever returned - a
 * pending or rejected `LeaveRequest` must never surface here, since
 * scheduling-service treats every record as an absolute, non-relaxable
 * hard constraint (ADR-0057). This is a `WHERE` clause, not an
 * application-level filter applied after the fact, so there is no code
 * path that could accidentally return an unapproved request.
 */
@Controller()
export class LeaveGrpcController {
  private readonly logger = new Logger(LeaveGrpcController.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @GrpcMethod('LeaveService', 'GetUnavailability')
  async getUnavailability(request: GetUnavailabilityRequest): Promise<{ records: UnavailabilityRecord[] }> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      try {
        const rows = await withTenantConnection(this.dataSource, request.tenantId, (manager) =>
          manager
            .createQueryBuilder(LeaveRequest, 'request')
            .where('request.tenantId = :tenantId', { tenantId: request.tenantId })
            .andWhere('request.employeeId IN (:...employeeIds)', {
              employeeIds: request.employeeIds?.length ? request.employeeIds : [null],
            })
            .andWhere('request.status = :status', { status: LeaveRequestStatus.APPROVED })
            .andWhere('request.dateRangeStart <= :end', { end: request.dateRangeEnd })
            .andWhere('request.dateRangeEnd >= :start', { start: request.dateRangeStart })
            .getMany(),
        );

        return {
          records: rows.map((row) => ({
            employeeId: row.employeeId,
            startDate: row.dateRangeStart,
            endDate: row.dateRangeEnd,
            leaveTypeId: row.leaveTypeId,
          })),
        };
      } catch (err) {
        this.logger.error(`GetUnavailability failed for tenant=${request.tenantId}: ${(err as Error).message}`);
        throw err;
      }
    });
  }
}
