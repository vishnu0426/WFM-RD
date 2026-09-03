import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ComplianceRuleService } from '../../../src/compliance/compliance-rule.service';
import {
  ComplianceRule,
  ComplianceRuleStatus,
  ComplianceRuleType,
} from '../../../src/compliance/entities/compliance-rule.entity';
import { ComplianceRuleCitationRequiredError } from '../../../src/compliance/errors/compliance-rule-citation-required.error';
import { InvalidComplianceRuleEffectiveRangeError } from '../../../src/compliance/errors/invalid-compliance-rule-effective-range.error';
import { ComplianceRuleNotFoundError } from '../../../src/compliance/errors/compliance-rule-not-found.error';
import { ComplianceRuleNotOwnedError } from '../../../src/compliance/errors/compliance-rule-not-owned.error';
import { ComplianceRuleNotPendingReviewError } from '../../../src/compliance/errors/compliance-rule-not-pending-review.error';
import { ImpactPreviewRequiredError } from '../../../src/compliance/errors/impact-preview-required.error';
import { ActivationJustificationRequiredError } from '../../../src/compliance/errors/activation-justification-required.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { CreateComplianceRuleInput } from '../../../src/compliance/types';

/**
 * `withTenantConnection` opens a real `dataSource.transaction(...)` call -
 * mocked here at the `DataSource` level (query/transaction), same pattern
 * every other service's own service-layer spec uses, rather than mocking
 * `withTenantConnection` itself (that would stop testing that this service
 * actually calls it, the one thing enforcing RLS on every query).
 */
describe('ComplianceRuleService', () => {
  let service: ComplianceRuleService;
  let manager: {
    query: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
    find: jest.Mock;
  };
  let recordEvent: jest.Mock;
  let recordImpactPreviewFlaggedButActivated: jest.Mock;

  beforeEach(async () => {
    manager = {
      query: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(),
      find: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)),
    };

    recordEvent = jest.fn().mockResolvedValue(undefined);
    recordImpactPreviewFlaggedButActivated = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ComplianceRuleService,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: MetricsService,
          useValue: {
            recordComplianceRuleCreation: jest.fn(),
            recordComplianceRuleActivation: jest.fn(),
            recordImpactPreviewFlaggedButActivated,
          },
        },
        { provide: AuditGrpcClientService, useValue: { recordEvent } },
      ],
    }).compile();

    service = moduleRef.get(ComplianceRuleService);
    void DataSource; // keep the import - documents intent, avoids an unused-import lint warning
  });

  const validInput: CreateComplianceRuleInput = {
    jurisdiction: 'US-CA',
    ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
    definition: { minMinutesPer4Hours: 10 },
    effectiveFrom: '2026-01-01',
    citation: 'Cal. Labor Code Section 226.7',
  };

  describe('createRule', () => {
    it('rejects a whitespace-only citation before ever touching the database', async () => {
      await expect(service.createRule('tenant-1', { ...validInput, citation: '   ' })).rejects.toBeInstanceOf(
        ComplianceRuleCitationRequiredError,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('rejects effectiveTo before effectiveFrom', async () => {
      await expect(
        service.createRule('tenant-1', { ...validInput, effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' }),
      ).rejects.toBeInstanceOf(InvalidComplianceRuleEffectiveRangeError);
    });

    it('always inserts status = pending_review, tenantId = the caller, and the computed next version', async () => {
      manager.query.mockResolvedValue([{ next_version: 3 }]);
      manager.findOneByOrFail.mockResolvedValue({ id: 'new-id' });

      await service.createRule('tenant-1', validInput);

      expect(manager.insert).toHaveBeenCalledWith(
        ComplianceRule,
        expect.objectContaining({
          tenantId: 'tenant-1',
          status: ComplianceRuleStatus.PENDING_REVIEW,
          activatedAt: null,
          version: 3,
          citation: validInput.citation,
        }),
      );
    });

    it("trims the citation before storing it, so a whitespace-padded but non-empty citation doesn't slip past intent", async () => {
      manager.query.mockResolvedValue([{ next_version: 1 }]);
      manager.findOneByOrFail.mockResolvedValue({ id: 'new-id' });

      await service.createRule('tenant-1', { ...validInput, citation: '  Cal. Labor Code Section 226.7  ' });

      expect(manager.insert).toHaveBeenCalledWith(
        ComplianceRule,
        expect.objectContaining({ citation: 'Cal. Labor Code Section 226.7' }),
      );
    });
  });

  describe('activateRule', () => {
    const pendingRule = {
      id: 'rule-1',
      tenantId: 'tenant-1',
      jurisdiction: 'US-CA',
      ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
      status: ComplianceRuleStatus.PENDING_REVIEW,
    };

    it('throws ComplianceRuleNotFoundError when the rule does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.activateRule('tenant-1', 'missing')).rejects.toBeInstanceOf(ComplianceRuleNotFoundError);
    });

    it('throws ComplianceRuleNotOwnedError for a platform-default row (tenantId: null), never lets the UPDATE attempt it', async () => {
      manager.findOne.mockResolvedValue({ ...pendingRule, tenantId: null });
      await expect(service.activateRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(ComplianceRuleNotOwnedError);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("throws ComplianceRuleNotOwnedError for another tenant's row", async () => {
      manager.findOne.mockResolvedValue({ ...pendingRule, tenantId: 'tenant-2' });
      await expect(service.activateRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(ComplianceRuleNotOwnedError);
    });

    it('throws ComplianceRuleNotPendingReviewError for an already-active rule', async () => {
      manager.findOne.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });
      await expect(service.activateRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(
        ComplianceRuleNotPendingReviewError,
      );
    });

    it('throws ImpactPreviewRequiredError when no RuleChangeImpactPreview exists for this rule, never lets the UPDATE attempt it', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([]);

      await expect(service.activateRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(ImpactPreviewRequiredError);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('activates normally when the latest preview flagged zero non-compliant employees, without recording an audit event', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 0, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      manager.findOneByOrFail.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });

      await service.activateRule('tenant-1', 'rule-1');

      expect(manager.update).toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
      expect(recordImpactPreviewFlaggedButActivated).not.toHaveBeenCalled();
    });

    it('throws ActivationJustificationRequiredError when the latest preview flagged non-compliant employees and no justificationNote is given, never lets the UPDATE attempt it', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 3, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);

      await expect(service.activateRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(
        ActivationJustificationRequiredError,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('throws ActivationJustificationRequiredError for a whitespace-only justificationNote', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 3, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);

      await expect(service.activateRule('tenant-1', 'rule-1', undefined, '   ')).rejects.toBeInstanceOf(
        ActivationJustificationRequiredError,
      );
    });

    it('activates anyway when the latest preview flagged non-compliant employees and a justificationNote is given, recording it on the audit event alongside the governance metric', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 3, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      manager.findOneByOrFail.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });

      const rule = await service.activateRule(
        'tenant-1',
        'rule-1',
        undefined,
        'Reviewed with legal; proceeding ahead of the next contract renewal.',
      );

      expect(rule.status).toBe(ComplianceRuleStatus.ACTIVE);
      expect(recordImpactPreviewFlaggedButActivated).toHaveBeenCalled();
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          action: 'compliance_rule_activated_despite_noncompliance',
          resourceType: 'compliance_rule',
          resourceId: 'rule-1',
          afterStateJson: expect.stringContaining('"wouldBecomeNoncompliantCount":3'),
        }),
      );
      const afterState = JSON.parse((recordEvent.mock.calls[0][0] as { afterStateJson: string }).afterStateJson);
      expect(afterState.justificationNote).toBe('Reviewed with legal; proceeding ahead of the next contract renewal.');
    });

    it('still activates when the best-effort audit call itself fails - the activation already committed', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 1, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      manager.findOneByOrFail.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });
      recordEvent.mockRejectedValue(new Error('AuditService unreachable'));

      const rule = await service.activateRule('tenant-1', 'rule-1', undefined, 'Justified override.');
      expect(rule.status).toBe(ComplianceRuleStatus.ACTIVE);
    });

    it('supersedes any other active row in the same scope before activating this one', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 0, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      manager.findOneByOrFail.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });

      await service.activateRule('tenant-1', 'rule-1');

      expect(manager.update).toHaveBeenCalledWith(
        ComplianceRule,
        {
          tenantId: 'tenant-1',
          jurisdiction: 'US-CA',
          ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
          status: ComplianceRuleStatus.ACTIVE,
        },
        { status: ComplianceRuleStatus.SUPERSEDED },
      );
      expect(manager.update).toHaveBeenCalledWith(
        ComplianceRule,
        { id: 'rule-1' },
        expect.objectContaining({ status: ComplianceRuleStatus.ACTIVE, activationDelayUntil: null }),
      );
    });

    it('sets activationDelayUntil from the effectiveAt argument (§0.5 progressive delivery)', async () => {
      manager.findOne.mockResolvedValue(pendingRule);
      manager.find.mockResolvedValue([
        { wouldBecomeNoncompliantCount: 0, generatedAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      manager.findOneByOrFail.mockResolvedValue({ ...pendingRule, status: ComplianceRuleStatus.ACTIVE });
      const effectiveAt = new Date('2026-12-01T00:00:00Z');

      await service.activateRule('tenant-1', 'rule-1', effectiveAt);

      expect(manager.update).toHaveBeenCalledWith(
        ComplianceRule,
        { id: 'rule-1' },
        expect.objectContaining({ activationDelayUntil: effectiveAt }),
      );
    });
  });

  describe('getOwnedRule', () => {
    const rule = {
      id: 'rule-1',
      tenantId: 'tenant-1',
      jurisdiction: 'US-CA',
      ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
    };

    it('throws ComplianceRuleNotFoundError when the rule does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.getOwnedRule('tenant-1', 'missing')).rejects.toBeInstanceOf(ComplianceRuleNotFoundError);
    });

    it("throws ComplianceRuleNotOwnedError for another tenant's row", async () => {
      manager.findOne.mockResolvedValue({ ...rule, tenantId: 'tenant-2' });
      await expect(service.getOwnedRule('tenant-1', 'rule-1')).rejects.toBeInstanceOf(ComplianceRuleNotOwnedError);
    });

    it('returns the rule when it exists and belongs to this tenant', async () => {
      manager.findOne.mockResolvedValue(rule);
      await expect(service.getOwnedRule('tenant-1', 'rule-1')).resolves.toEqual(rule);
    });
  });

  describe('getActiveRule', () => {
    it('filters to the requested ruleType before resolving, so a rule of a different type never survives', async () => {
      const restRule = {
        id: 'rest-rule',
        tenantId: null,
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        definition: {},
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        version: 1,
        citation: 'cite',
        status: ComplianceRuleStatus.ACTIVE,
        activationDelayUntil: null,
      };
      const overtimeRule = { ...restRule, id: 'ot-rule', ruleType: ComplianceRuleType.OVERTIME_THRESHOLD };
      manager.find.mockResolvedValue([restRule, overtimeRule]);

      const result = await service.getActiveRule(
        'tenant-1',
        'US-CA',
        ComplianceRuleType.REST_PERIOD_MINIMUM,
        new Date(),
      );

      expect(result?.id).toBe('rest-rule');
    });

    it('returns null when no rule of that type is currently effective', async () => {
      manager.find.mockResolvedValue([]);
      const result = await service.getActiveRule(
        'tenant-1',
        'US-CA',
        ComplianceRuleType.REST_PERIOD_MINIMUM,
        new Date(),
      );
      expect(result).toBeNull();
    });
  });
});
