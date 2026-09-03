import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AlertPolicy, SuppressionRule } from './entities/alert-policy.entity';

export interface ResolvedAlertPolicy {
  dedupWindowMinutes: number;
  suppressionAckWindowMinutes: number;
  escalationThresholdMinutes: number;
  suppressionRules: SuppressionRule[];
}

/** Same defaults the migration's own column defaults use - kept as one literal here so the "no row for this tenant" path and the "row was inserted with defaults" path can never silently diverge. */
export const DEFAULT_ALERT_POLICY: ResolvedAlertPolicy = {
  dedupWindowMinutes: 5,
  suppressionAckWindowMinutes: 15,
  escalationThresholdMinutes: 15,
  suppressionRules: [],
};

/** §5a's policy-as-data - a self-contained per-tenant table, not Module 01's generic `Policy` system (design doc assumption 2). */
@Injectable()
export class AlertPolicyService {
  async getPolicy(manager: EntityManager, tenantId: string): Promise<ResolvedAlertPolicy> {
    const row = await manager.getRepository(AlertPolicy).findOne({ where: { tenantId } });
    if (!row) {
      return DEFAULT_ALERT_POLICY;
    }
    return {
      dedupWindowMinutes: row.dedupWindowMinutes,
      suppressionAckWindowMinutes: row.suppressionAckWindowMinutes,
      escalationThresholdMinutes: row.escalationThresholdMinutes,
      suppressionRules: row.suppressionRules,
    };
  }

  /** §5a's "expected lunch-hour dip" example - a time-of-day match, optionally scoped to one queue. */
  matchesSuppressionRule(rules: SuppressionRule[], alertType: string, queueId: string | null, now: Date): boolean {
    const hourUtc = now.getUTCHours();
    return rules.some((rule) => {
      if (rule.alertType !== alertType) {
        return false;
      }
      if (rule.queueId !== null && rule.queueId !== queueId) {
        return false;
      }
      return isHourWithinWindow(hourUtc, rule.startHourUtc, rule.endHourUtc);
    });
  }
}

/** Handles a window that wraps midnight (e.g. 22-6) as well as a normal one (e.g. 12-13). */
function isHourWithinWindow(hour: number, startHourUtc: number, endHourUtc: number): boolean {
  if (startHourUtc <= endHourUtc) {
    return hour >= startHourUtc && hour < endHourUtc;
  }
  return hour >= startHourUtc || hour < endHourUtc;
}
