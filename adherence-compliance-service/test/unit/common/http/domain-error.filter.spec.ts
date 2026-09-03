import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { DomainErrorFilter } from '../../../../src/common/http/domain-error.filter';
import { DomainError } from '../../../../src/common/errors/domain-error';
import { InvalidTenantIdError, TenantContextMissingError } from '../../../../src/common/tenant/tenant-context.errors';
import { ComplianceRuleNotFoundError } from '../../../../src/compliance/errors/compliance-rule-not-found.error';
import { ComplianceRuleNotPendingReviewError } from '../../../../src/compliance/errors/compliance-rule-not-pending-review.error';
import { ComplianceRuleCitationRequiredError } from '../../../../src/compliance/errors/compliance-rule-citation-required.error';
import { InvalidComplianceRuleEffectiveRangeError } from '../../../../src/compliance/errors/invalid-compliance-rule-effective-range.error';
import { ComplianceRuleNotOwnedError } from '../../../../src/compliance/errors/compliance-rule-not-owned.error';
import { ComplianceReportNotFoundError } from '../../../../src/compliance/reports/errors/compliance-report-not-found.error';
import { OrgUnitScopeRequiredError } from '../../../../src/compliance/reports/errors/org-unit-scope-required.error';
import { ImpactPreviewRequiredError } from '../../../../src/compliance/errors/impact-preview-required.error';
import { ScheduleQueryGrpcClientUnavailableError } from '../../../../src/grpc/schedule-query-grpc-client.service';

describe('DomainErrorFilter', () => {
  const filter = new DomainErrorFilter();

  function restHost(): { host: ArgumentsHost; status: jest.Mock; json: jest.Mock } {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      getType: () => 'http' as GqlContextType,
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  const cases: Array<[DomainError, HttpStatus]> = [
    [new TenantContextMissingError(), HttpStatus.BAD_REQUEST],
    [new InvalidTenantIdError('bad-id'), HttpStatus.BAD_REQUEST],
    [new ComplianceRuleNotFoundError('rule-1'), HttpStatus.NOT_FOUND],
    [new ComplianceRuleNotPendingReviewError('rule-1', 'active'), HttpStatus.CONFLICT],
    [new ComplianceRuleCitationRequiredError(), HttpStatus.BAD_REQUEST],
    [new InvalidComplianceRuleEffectiveRangeError(), HttpStatus.BAD_REQUEST],
    [new ComplianceRuleNotOwnedError('rule-1'), HttpStatus.FORBIDDEN],
    [new ComplianceReportNotFoundError('report-1'), HttpStatus.NOT_FOUND],
    [new OrgUnitScopeRequiredError('overtime_audit'), HttpStatus.BAD_REQUEST],
    [new ImpactPreviewRequiredError('rule-1'), HttpStatus.CONFLICT],
    [new ScheduleQueryGrpcClientUnavailableError(new Error('UNAVAILABLE')), HttpStatus.SERVICE_UNAVAILABLE],
  ];

  it.each(cases)('maps %p to %s on the REST path', (error, expectedStatus) => {
    const { host, status, json } = restHost();
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith({ error: { code: error.code, message: error.message } });
  });

  it('falls back to 500 for an unregistered DomainError subclass', () => {
    class UnregisteredError extends DomainError {
      readonly code = 'UNREGISTERED';
      constructor() {
        super('UNREGISTERED', 'not in the map');
      }
    }
    const { host, status } = restHost();
    filter.catch(new UnregisteredError(), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('rethrows instead of touching a non-Express response for a GraphQL context, letting formatGraphQLError handle it', () => {
    const host = { getType: () => 'graphql' as GqlContextType, switchToHttp: jest.fn() } as unknown as ArgumentsHost;
    expect(() => filter.catch(new ComplianceRuleNotFoundError('rule-1'), host)).toThrow(ComplianceRuleNotFoundError);
    expect(host.switchToHttp).not.toHaveBeenCalled();
  });
});
