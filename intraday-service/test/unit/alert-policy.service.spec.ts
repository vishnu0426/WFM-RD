import { AlertPolicyService, DEFAULT_ALERT_POLICY } from '../../src/alerting/alert-policy.service';
import { SuppressionRule } from '../../src/alerting/entities/alert-policy.entity';

describe('AlertPolicyService', () => {
  describe('getPolicy', () => {
    it('returns DEFAULT_ALERT_POLICY when no row exists for the tenant', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null) };
      const manager = { getRepository: jest.fn().mockReturnValue(repository) };
      const service = new AlertPolicyService();

      const policy = await service.getPolicy(manager as never, 't1');

      expect(policy).toEqual(DEFAULT_ALERT_POLICY);
      expect(repository.findOne).toHaveBeenCalledWith({ where: { tenantId: 't1' } });
    });

    it('maps a stored row into a ResolvedAlertPolicy', async () => {
      const row = {
        tenantId: 't1',
        dedupWindowMinutes: 10,
        suppressionAckWindowMinutes: 20,
        escalationThresholdMinutes: 30,
        suppressionRules: [{ alertType: 'service_level_breach', queueId: null, startHourUtc: 12, endHourUtc: 13 }],
      };
      const repository = { findOne: jest.fn().mockResolvedValue(row) };
      const manager = { getRepository: jest.fn().mockReturnValue(repository) };
      const service = new AlertPolicyService();

      const policy = await service.getPolicy(manager as never, 't1');

      expect(policy).toEqual({
        dedupWindowMinutes: 10,
        suppressionAckWindowMinutes: 20,
        escalationThresholdMinutes: 30,
        suppressionRules: row.suppressionRules,
      });
    });
  });

  describe('matchesSuppressionRule', () => {
    const service = new AlertPolicyService();

    it('matches a normal (non-wrapping) hour window', () => {
      const rules: SuppressionRule[] = [
        { alertType: 'service_level_breach', queueId: null, startHourUtc: 12, endHourUtc: 13 },
      ];
      const now = new Date('2026-08-07T12:30:00.000Z');

      expect(service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', now)).toBe(true);
    });

    it('does not match outside the window', () => {
      const rules: SuppressionRule[] = [
        { alertType: 'service_level_breach', queueId: null, startHourUtc: 12, endHourUtc: 13 },
      ];
      const now = new Date('2026-08-07T14:00:00.000Z');

      expect(service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', now)).toBe(false);
    });

    it('handles a window that wraps midnight', () => {
      const rules: SuppressionRule[] = [
        { alertType: 'service_level_breach', queueId: null, startHourUtc: 22, endHourUtc: 6 },
      ];

      expect(
        service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', new Date('2026-08-07T23:00:00.000Z')),
      ).toBe(true);
      expect(
        service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', new Date('2026-08-07T02:00:00.000Z')),
      ).toBe(true);
      expect(
        service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', new Date('2026-08-07T10:00:00.000Z')),
      ).toBe(false);
    });

    it('does not match a different alertType', () => {
      const rules: SuppressionRule[] = [{ alertType: 'other_type', queueId: null, startHourUtc: 0, endHourUtc: 23 }];
      const now = new Date('2026-08-07T12:00:00.000Z');

      expect(service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', now)).toBe(false);
    });

    it('a queue-scoped rule only matches that queue', () => {
      const rules: SuppressionRule[] = [
        { alertType: 'service_level_breach', queueId: 'q1', startHourUtc: 12, endHourUtc: 13 },
      ];
      const now = new Date('2026-08-07T12:30:00.000Z');

      expect(service.matchesSuppressionRule(rules, 'service_level_breach', 'q1', now)).toBe(true);
      expect(service.matchesSuppressionRule(rules, 'service_level_breach', 'q2', now)).toBe(false);
    });
  });
});
