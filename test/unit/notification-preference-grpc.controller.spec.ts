import { NotificationPreferenceGrpcController } from '../../src/grpc/controllers/notification-preference-grpc.controller';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { NotificationChannel } from '../../src/modules/notification/entities/notification-channel.enum';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ORG_UNIT_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_TYPE = 'leave.request.approved';

interface PreferenceOverride {
  channel: NotificationChannel;
  eventType: string;
  enabled: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

function buildController(overrides?: {
  employee?: { userId: string | null; orgUnitId?: string | null } | null;
  preferences?: PreferenceOverride[];
  calendar?: { timezone: string } | null;
  calendarError?: Error;
}) {
  const tenantContext = new TenantContextService();
  const employeesRepository = {
    findById: jest
      .fn()
      .mockResolvedValue(
        overrides?.employee === undefined ? { userId: USER_ID, orgUnitId: ORG_UNIT_ID } : overrides.employee,
      ),
  };
  const notificationPreferencesRepository = {
    findForUser: jest.fn().mockResolvedValue(overrides?.preferences ?? []),
  };
  const workingTimeCalendarsService = {
    findForOrgUnit: overrides?.calendarError
      ? jest.fn().mockRejectedValue(overrides.calendarError)
      : jest.fn().mockResolvedValue(overrides?.calendar === undefined ? { timezone: 'UTC' } : overrides.calendar),
  };
  const controller = new NotificationPreferenceGrpcController(
    tenantContext,
    employeesRepository as never,
    notificationPreferencesRepository as never,
    workingTimeCalendarsService as never,
  );
  return { controller, employeesRepository, notificationPreferencesRepository, workingTimeCalendarsService };
}

async function callIsPushEnabled(controller: NotificationPreferenceGrpcController) {
  return controller.isPushEnabled({ tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, eventType: EVENT_TYPE });
}

describe('NotificationPreferenceGrpcController.isPushEnabled', () => {
  it('returns enabled=true and employeeHasLinkedUser=true when a matching PUSH preference row is enabled', async () => {
    const { controller } = buildController({
      preferences: [{ channel: NotificationChannel.PUSH, eventType: EVENT_TYPE, enabled: true }],
    });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
  });

  it('returns enabled=false when the matching PUSH preference row is explicitly disabled', async () => {
    const { controller } = buildController({
      preferences: [{ channel: NotificationChannel.PUSH, eventType: EVENT_TYPE, enabled: false }],
    });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: false, employeeHasLinkedUser: true });
  });

  it('ignores a preference row for a different channel or event type', async () => {
    const { controller } = buildController({
      preferences: [
        { channel: NotificationChannel.EMAIL, eventType: EVENT_TYPE, enabled: false },
        { channel: NotificationChannel.PUSH, eventType: 'some.other.event', enabled: false },
      ],
    });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
  });

  it('defaults to enabled when no preference row exists at all (opt-out model, ADR-0154)', async () => {
    const { controller } = buildController({ preferences: [] });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
  });

  it('defaults to enabled and reports employeeHasLinkedUser=false when the employee has no linked user account', async () => {
    const { controller, notificationPreferencesRepository } = buildController({
      employee: { userId: null, orgUnitId: ORG_UNIT_ID },
    });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: false });
    expect(notificationPreferencesRepository.findForUser).not.toHaveBeenCalled();
  });

  it('defaults to enabled and reports employeeHasLinkedUser=false when the employee does not exist', async () => {
    const { controller } = buildController({ employee: null });
    const result = await callIsPushEnabled(controller);
    expect(result).toEqual({ enabled: true, employeeHasLinkedUser: false });
  });

  describe('quiet hours (Module 11 Gap 4, docs/adr/0154)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns enabled=false when the current UTC time falls inside a same-day quiet-hours window', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T22:30:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: '23:00:00',
          },
        ],
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: false, employeeHasLinkedUser: true });
    });

    it('returns enabled=true when the current UTC time falls outside a same-day quiet-hours window', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: '23:00:00',
          },
        ],
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
    });

    it('handles a quiet-hours window that wraps midnight (e.g. 22:00 -> 07:00)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T02:00:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: '07:00:00',
          },
        ],
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: false, employeeHasLinkedUser: true });
    });

    it('a midnight-wrapping window does not suppress a send at a time outside it', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: '07:00:00',
          },
        ],
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
    });

    it('fails open (enabled=true) when the timezone/calendar lookup throws', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T22:30:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: '23:00:00',
          },
        ],
        calendarError: new Error('org unit lookup failed'),
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
    });

    it('ignores quiet hours entirely when only one of quietHoursStart/quietHoursEnd is set', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T22:30:00Z'));
      const { controller } = buildController({
        preferences: [
          {
            channel: NotificationChannel.PUSH,
            eventType: EVENT_TYPE,
            enabled: true,
            quietHoursStart: '22:00:00',
            quietHoursEnd: null,
          },
        ],
      });
      const result = await callIsPushEnabled(controller);
      expect(result).toEqual({ enabled: true, employeeHasLinkedUser: true });
    });
  });
});
