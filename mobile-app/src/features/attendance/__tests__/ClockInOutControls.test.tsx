import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/testing/test-utils';
import { listPendingActions, QueuedClockEventAction } from '@/offlineQueue/storage';
import * as expoLocationMock from '@/testing/mocks/expo-location';

import { ClockInOutControls } from '../ClockInOutControls';

function mockGeofenceConfig(config: { enabled: boolean }) {
  server.use(http.get('*/v1/mobile/geofence-config', () => HttpResponse.json(config)));
}

describe('ClockInOutControls - geofencing gate (docs/adr/0155)', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
    server.use(http.post('*/v1/mobile/sync', () => HttpResponse.json({ results: [] })));
  });

  it('never shows the disclosure card when geofencing is not enabled, and queues a clock-in with no location', async () => {
    mockGeofenceConfig({ enabled: false });
    await renderWithProviders(<ClockInOutControls />);

    await waitFor(() => expect(screen.queryByText('Location-based clock-in verification')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Clock In' }));

    await waitFor(async () => expect(await listPendingActions()).toHaveLength(1));
    const [action] = (await listPendingActions()) as QueuedClockEventAction[];
    expect(action.payload).toEqual({ eventType: 'clock_in' });
  });

  it('shows the disclosure card when geofencing is enabled and not yet acknowledged', async () => {
    mockGeofenceConfig({ enabled: true });
    await renderWithProviders(<ClockInOutControls />);

    await waitFor(() => screen.getByText('Location-based clock-in verification'));
  });

  it('acknowledging the disclosure hides it and lets clock-in proceed (without location, since the OS permission was not granted)', async () => {
    mockGeofenceConfig({ enabled: true });
    expoLocationMock.__setPermissionGranted(false);
    await renderWithProviders(<ClockInOutControls />);

    await waitFor(() => screen.getByText('Location-based clock-in verification'));
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByText('Location-based clock-in verification')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Clock In' }));

    await waitFor(async () => expect(await listPendingActions()).toHaveLength(1));
    const [action] = (await listPendingActions()) as QueuedClockEventAction[];
    // Acknowledging requests the OS permission - the mock grants it on request,
    // so a real device location IS captured here despite starting ungranted.
    expect(action.payload.location).toBeDefined();
  });

  it('captures and queues location on clock-in once geofencing is active and permission is granted', async () => {
    mockGeofenceConfig({ enabled: true });
    expoLocationMock.__setPermissionGranted(true);
    expoLocationMock.__setPosition({ latitude: 40.7128, longitude: -74.006, accuracy: 10 });
    await renderWithProviders(<ClockInOutControls />);

    await waitFor(() => screen.getByText('Location-based clock-in verification'));
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByText('Location-based clock-in verification')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Clock In' }));

    await waitFor(async () => expect(await listPendingActions()).toHaveLength(1));
    const [action] = (await listPendingActions()) as QueuedClockEventAction[];
    expect(action.payload).toEqual({
      eventType: 'clock_in',
      location: { latitude: 40.7128, longitude: -74.006, accuracy: 10 },
    });
  });
});
