import { delay, http, HttpResponse } from 'msw';

import { mockShiftAssignment } from '@/testing/mocks/handlers';
import { server } from '@/testing/mocks/server';
import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { renderWithProviders, screen, waitFor } from '@/testing/test-utils';

import { ScheduleScreen } from '../ScheduleScreen';

const SHIFT_ASSIGNMENTS_URL = '*/v1/scheduling/employees/:employeeId/shift-assignments';

describe('ScheduleScreen', () => {
  beforeEach(async () => {
    // ScheduleScreen only ever mounts inside the authenticated (tabs)
    // stack in the real app (Stack.Protected, app/_layout.tsx) — the test
    // wrapper's AuthGate mirrors that, so every test needs a real session.
    await seedAuthenticatedSession();
  });

  it('shows a loading state while the request is in flight', async () => {
    // Holds the response open for the life of the test so no state update
    // happens after assertions run (would otherwise warn outside act()).
    server.use(
      http.get(SHIFT_ASSIGNMENTS_URL, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );

    await renderWithProviders(<ScheduleScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText('Loading your schedule')).toBeTruthy();
    });
  });

  it('renders shift assignments once loaded, with an accessible label', async () => {
    await renderWithProviders(<ScheduleScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Fri, Aug 14/)).toBeTruthy();
    });
  });

  it('shows an empty state when there are no upcoming shifts', async () => {
    server.use(http.get(SHIFT_ASSIGNMENTS_URL, () => HttpResponse.json([])));

    await renderWithProviders(<ScheduleScreen />);

    await waitFor(() => {
      expect(screen.getByText('No upcoming shifts')).toBeTruthy();
    });
  });

  it('shows a retryable error state when the request fails', async () => {
    server.use(http.get(SHIFT_ASSIGNMENTS_URL, () => HttpResponse.error()));

    await renderWithProviders(<ScheduleScreen />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your schedule")).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('marks overtime shifts distinctly', async () => {
    server.use(
      http.get(SHIFT_ASSIGNMENTS_URL, () =>
        HttpResponse.json([{ ...mockShiftAssignment, isOvertime: true }]),
      ),
    );

    await renderWithProviders(<ScheduleScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText(/overtime/)).toBeTruthy();
    });
  });
});
