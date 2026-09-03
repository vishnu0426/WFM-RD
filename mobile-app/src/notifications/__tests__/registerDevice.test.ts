import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { setBiometricUnlockEnabled } from '@/auth/biometric';

import { registerDevice } from '../registerDevice';

const DEVICES_URL = '*/v1/mobile/devices';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';

describe('registerDevice', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('sends the expected payload, reading biometricEnrolled from the local Phase 2 flag', async () => {
    await setBiometricUnlockEnabled(true);
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(DEVICES_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'device-1', deviceType: 'ios', active: true, lastActiveAt: '2026-08-14T09:00:00.000Z' });
      }),
    );

    await registerDevice({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      deviceType: 'ios',
      deviceId: 'install-uuid-1',
      pushToken: 'ExponentPushToken[abc]',
    });

    expect(capturedBody).toMatchObject({
      employeeId: EMPLOYEE_ID,
      deviceType: 'ios',
      deviceId: 'install-uuid-1',
      pushToken: 'ExponentPushToken[abc]',
      biometricEnrolled: true,
    });
  });

  it('sends biometricEnrolled=false when the local flag has never been set', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(DEVICES_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 'device-1', deviceType: 'android', active: true, lastActiveAt: '2026-08-14T09:00:00.000Z' });
      }),
    );

    await registerDevice({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      deviceType: 'android',
      deviceId: 'install-uuid-1',
      pushToken: 'ExponentPushToken[def]',
    });

    expect(capturedBody?.biometricEnrolled).toBe(false);
  });
});
