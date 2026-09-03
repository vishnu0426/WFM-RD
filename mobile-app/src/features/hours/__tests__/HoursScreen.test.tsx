import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { renderWithProviders, screen, waitFor } from '@/testing/test-utils';

import { HoursScreen } from '../HoursScreen';

const RECORDS_URL = '*/v1/attendance/employees/:employeeId/records';
const BALANCES_URL = '*/v1/leave/employees/:employeeId/balances';

const CLOSED_RECORD = {
  id: 'r1',
  employeeId: '22222222-2222-4222-8222-222222222222',
  clockInAt: '2026-08-13T09:00:00.000Z',
  clockOutAt: '2026-08-13T17:00:00.000Z',
  source: 'mobile_app',
  scheduledShiftId: null,
  exceptionType: null,
  exceptionMinutes: null,
  geofenceVerified: null,
};

const OPEN_RECORD = {
  ...CLOSED_RECORD,
  id: 'r2',
  clockInAt: '2026-08-14T09:00:00.000Z',
  clockOutAt: null,
};

const BALANCE = {
  leaveTypeId: 'lt-1',
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  accruedDays: '20.00',
  usedDays: '5.00',
  pendingDays: '2.00',
  availableDays: '13.00',
  carryoverDaysIn: '0.00',
  carryoverExpiryDate: null,
};

describe('HoursScreen', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('shows the computed total hours from closed records once loaded', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.json([CLOSED_RECORD])));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([BALANCE])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => screen.getByText('8.0 hours'));
  });

  it('excludes a still-open record from the total and shows it as "in progress"', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.json([CLOSED_RECORD, OPEN_RECORD])));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([BALANCE])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => screen.getByText('8.0 hours'));
    expect(screen.getByText(/in progress/)).toBeTruthy();
  });

  it('shows an empty state when there are no attendance records in the window', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.json([])));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([BALANCE])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => screen.getByText('No attendance records in the last 14 days'));
  });

  it('shows an empty state, not an error, when there is no leave balance on record', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.json([CLOSED_RECORD])));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => screen.getByText('No leave balance on record'));
  });

  it('renders leave balance details once loaded', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.json([CLOSED_RECORD])));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([BALANCE])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => screen.getByText('13.00 days available'));
  });

  it('shows a retryable error for one section while the other still succeeds', async () => {
    server.use(http.get(RECORDS_URL, () => HttpResponse.error()));
    server.use(http.get(BALANCES_URL, () => HttpResponse.json([BALANCE])));

    await renderWithProviders(<HoursScreen />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your hours")).toBeTruthy();
      expect(screen.getByText('13.00 days available')).toBeTruthy();
    });
  });
});
