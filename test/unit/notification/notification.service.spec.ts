import { NotificationService } from '../../../src/modules/notification/services/notification.service';
import { NotificationChannel } from '../../../src/modules/notification/entities/notification-channel.enum';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function preference(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pref-1',
    tenantId: TENANT_ID,
    userId: USER_ID,
    channel: NotificationChannel.EMAIL,
    eventType: 'skill_expiring',
    enabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('NotificationService (GAP-05 fix, enterprise readiness audit 2026-08-18)', () => {
  let tenantContext: { requireTenantId: jest.Mock };
  let preferencesRepository: { findForUser: jest.Mock };
  let deliveryRepository: { enqueue: jest.Mock };
  let rulesRepository: { findForEventType: jest.Mock };
  let service: NotificationService;

  beforeEach(() => {
    tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
    preferencesRepository = { findForUser: jest.fn().mockResolvedValue([]) };
    deliveryRepository = { enqueue: jest.fn().mockResolvedValue(undefined) };
    rulesRepository = { findForEventType: jest.fn().mockResolvedValue([]) };
    service = new NotificationService(
      tenantContext as never,
      preferencesRepository as never,
      deliveryRepository as never,
      rulesRepository as never,
    );
  });

  it('enqueues one notification_delivery row per enabled channel matching the event type', async () => {
    preferencesRepository.findForUser.mockResolvedValue([
      preference({ id: 'p1', channel: NotificationChannel.EMAIL, enabled: true }),
      preference({ id: 'p2', channel: NotificationChannel.PUSH, enabled: true }),
    ]);

    const count = await service.enqueue(USER_ID, 'skill_expiring', { skillId: 'skill-1' });

    expect(count).toBe(2);
    expect(deliveryRepository.enqueue).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      NotificationChannel.EMAIL,
      'skill_expiring',
      { skillId: 'skill-1' },
    );
    expect(deliveryRepository.enqueue).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      NotificationChannel.PUSH,
      'skill_expiring',
      { skillId: 'skill-1' },
    );
  });

  it('skips a channel whose preference is disabled', async () => {
    preferencesRepository.findForUser.mockResolvedValue([
      preference({ channel: NotificationChannel.EMAIL, enabled: false }),
    ]);

    const count = await service.enqueue(USER_ID, 'skill_expiring', {});

    expect(count).toBe(0);
    expect(deliveryRepository.enqueue).not.toHaveBeenCalled();
  });

  it('skips a preference row for a different event type', async () => {
    preferencesRepository.findForUser.mockResolvedValue([preference({ eventType: 'leave_approved', enabled: true })]);

    const count = await service.enqueue(USER_ID, 'skill_expiring', {});

    expect(count).toBe(0);
    expect(deliveryRepository.enqueue).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the user has no preference rows and no tenant rule exists', async () => {
    preferencesRepository.findForUser.mockResolvedValue([]);

    await expect(service.enqueue(USER_ID, 'skill_expiring', {})).resolves.toBe(0);
    expect(deliveryRepository.enqueue).not.toHaveBeenCalled();
  });

  it('falls back to the tenant-wide NotificationRule when the user has no explicit preference for a channel', async () => {
    preferencesRepository.findForUser.mockResolvedValue([]);
    rulesRepository.findForEventType.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: true, eventType: 'skill_expiring' },
    ]);

    const count = await service.enqueue(USER_ID, 'skill_expiring', { skillId: 'skill-1' });

    expect(count).toBe(1);
    expect(deliveryRepository.enqueue).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      NotificationChannel.EMAIL,
      'skill_expiring',
      { skillId: 'skill-1' },
    );
  });

  it('an explicit user preference always overrides the tenant-wide rule for that channel', async () => {
    preferencesRepository.findForUser.mockResolvedValue([
      preference({ channel: NotificationChannel.EMAIL, enabled: false }),
    ]);
    rulesRepository.findForEventType.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: true, eventType: 'skill_expiring' },
    ]);

    const count = await service.enqueue(USER_ID, 'skill_expiring', {});

    expect(count).toBe(0);
    expect(deliveryRepository.enqueue).not.toHaveBeenCalled();
  });
});
