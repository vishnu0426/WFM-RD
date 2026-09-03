import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../tenant/tenant-context.errors';
import { InvalidSignatureError } from '../errors/invalid-signature.error';
import { UpstreamUnavailableError } from '../errors/upstream-unavailable.error';
import { NoOpenAttendanceRecordError } from '../errors/no-open-attendance-record.error';
import { AttendanceRecordConflictError } from '../errors/attendance-record-conflict.error';
import { InvalidLeaveRequestError } from '../errors/invalid-leave-request.error';
import { BackdatedLeaveNotSupportedError } from '../errors/backdated-leave-not-supported.error';
import { LeaveBalanceNotFoundError } from '../errors/leave-balance-not-found.error';
import { InsufficientLeaveBalanceError } from '../errors/insufficient-leave-balance.error';
import { LeaveRequestOverlapError } from '../errors/leave-request-overlap.error';
import { LeaveRequestNotFoundError } from '../errors/leave-request-not-found.error';
import { LeaveRequestAlreadyDecidedError } from '../errors/leave-request-already-decided.error';
import { NotActuallyBackdatedError } from '../errors/not-actually-backdated.error';
import { InsufficientPermissionError } from '../errors/insufficient-permission.error';
import { AbsencePatternNotFoundError } from '../errors/absence-pattern-not-found.error';
import { AbsencePatternAlreadyAcknowledgedError } from '../errors/absence-pattern-already-acknowledged.error';
import { LeaveTypeNotFoundError } from '../errors/leave-type-not-found.error';
import { LeaveTypeInUseError } from '../errors/leave-type-in-use.error';
import { LeaveBalanceAlreadyExistsError } from '../errors/leave-balance-already-exists.error';
import { AccrualPolicyNotFoundError } from '../errors/accrual-policy-not-found.error';
import { AccrualPolicyInUseError } from '../errors/accrual-policy-in-use.error';

type DomainErrorClass = new (...args: never[]) => DomainError;

const STATUS_BY_ERROR = new Map<DomainErrorClass, HttpStatus>([
  [TenantContextMissingError, HttpStatus.BAD_REQUEST],
  [InvalidTenantIdError, HttpStatus.BAD_REQUEST],
  [InvalidSignatureError, HttpStatus.UNAUTHORIZED],
  [UpstreamUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [NoOpenAttendanceRecordError, HttpStatus.CONFLICT],
  [AttendanceRecordConflictError, HttpStatus.CONFLICT],
  [InvalidLeaveRequestError, HttpStatus.BAD_REQUEST],
  [BackdatedLeaveNotSupportedError, HttpStatus.BAD_REQUEST],
  [LeaveBalanceNotFoundError, HttpStatus.NOT_FOUND],
  [InsufficientLeaveBalanceError, HttpStatus.CONFLICT],
  [LeaveRequestOverlapError, HttpStatus.CONFLICT],
  [LeaveRequestNotFoundError, HttpStatus.NOT_FOUND],
  [LeaveRequestAlreadyDecidedError, HttpStatus.CONFLICT],
  [NotActuallyBackdatedError, HttpStatus.BAD_REQUEST],
  [InsufficientPermissionError, HttpStatus.FORBIDDEN],
  [AbsencePatternNotFoundError, HttpStatus.NOT_FOUND],
  [AbsencePatternAlreadyAcknowledgedError, HttpStatus.CONFLICT],
  [LeaveTypeNotFoundError, HttpStatus.NOT_FOUND],
  [LeaveTypeInUseError, HttpStatus.CONFLICT],
  [LeaveBalanceAlreadyExistsError, HttpStatus.CONFLICT],
  [AccrualPolicyNotFoundError, HttpStatus.NOT_FOUND],
  [AccrualPolicyInUseError, HttpStatus.CONFLICT],
]);

/**
 * Maps typed `DomainError` subclasses to an HTTP status + the platform's
 * standard error envelope (ADR-0015), mirrors intraday-service's own
 * `domain-error.filter.ts`. Every later phase adding a new `DomainError`
 * subclass registers its status here rather than throwing raw
 * `HttpException`s from controllers/services.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = STATUS_BY_ERROR.get(exception.constructor as DomainErrorClass) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      error: {
        code: exception.code,
        message: exception.message,
      },
    });
  }
}
