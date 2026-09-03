import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { renderWithProviders, screen, waitFor } from '@/testing/test-utils';
import { Text } from 'react-native';

import { useRegisterDeviceOnAuth } from '../useRegisterDeviceOnAuth';

const DEVICES_URL = '*/v1/mobile/devices';

function TestComponent({ marker }: { marker?: string }) {
  useRegisterDeviceOnAuth();
  return <Text>registered{marker ?? ''}</Text>;
}

describe('useRegisterDeviceOnAuth', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('registers the device once on the authenticated transition', async () => {
    let callCount = 0;
    server.use(
      http.post(DEVICES_URL, () => {
        callCount += 1;
        return HttpResponse.json({ id: 'device-1', deviceType: 'ios', active: true, lastActiveAt: '2026-08-14T09:00:00.000Z' });
      }),
    );

    await renderWithProviders(<TestComponent />);

    await waitFor(() => screen.getByText('registered'));
    await waitFor(() => expect(callCount).toBe(1));
  });

  it('does not re-register on an unrelated re-render (stable tenantId/employeeId)', async () => {
    let callCount = 0;
    server.use(
      http.post(DEVICES_URL, () => {
        callCount += 1;
        return HttpResponse.json({ id: 'device-1', deviceType: 'ios', active: true, lastActiveAt: '2026-08-14T09:00:00.000Z' });
      }),
    );

    const { rerender } = await renderWithProviders(<TestComponent />);
    await waitFor(() => expect(callCount).toBe(1));

    await rerender(<TestComponent marker="-again" />);
    await waitFor(() => screen.getByText('registered-again'));

    expect(callCount).toBe(1);
  });
});
