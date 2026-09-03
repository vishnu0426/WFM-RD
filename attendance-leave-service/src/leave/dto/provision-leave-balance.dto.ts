import { IsDateString, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * `POST /v1/leave/employees/:employeeId/balances` — closes the previously
 * disclosed gap that no admin write path exists for `LeaveBalance` at all
 * (see that entity's `LeaveBalanceNotFoundError` doc comment): an HR admin
 * can now provision a period's balance directly instead of it requiring a
 * manual SQL insert. Deliberately just a create, not a recurring accrual
 * engine — this service still has no `AccrualPolicy` catalog to drive one
 * from (`accrualPolicyId` on `LeaveType` is a free-form id, not a resolvable
 * policy record), so a periodic accrual job remains a separate, larger
 * feature this endpoint does not attempt to be.
 */
export class ProvisionLeaveBalanceDto {
  @IsUUID()
  leaveTypeId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsNumber()
  @Min(0)
  accruedDays!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  carryoverDaysIn?: number;

  @IsOptional()
  @IsDateString()
  carryoverExpiryDate?: string;
}
