import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/testing/test-utils';
import { listPendingActions } from '@/offlineQueue/storage';

import { LeaveRequestScreen } from '../LeaveRequestScreen';

describe('LeaveRequestScreen - sync-queue-hygiene guardrail', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('rejects an inverted date range client-side and never queues the action', async () => {
    // Without this guardrail, attendance-leave-service's own
    // InvalidLeaveRequestError becomes a reachable, deterministic,
    // always-reproducing conflict from this form's own input - this test
    // guards the offline queue's own hygiene, not generic form UX
    // (docs/adr/0153).
    await renderWithProviders(<LeaveRequestScreen />);

    await waitFor(() => screen.getByLabelText('Leave type ID'));

    await fireEvent.changeText(screen.getByLabelText('Leave type ID'), 'lt-1');
    await fireEvent.changeText(screen.getByLabelText('Start date'), '2026-09-05');
    await fireEvent.changeText(screen.getByLabelText('End date'), '2026-09-01');
    await fireEvent.press(screen.getByRole('button', { name: 'Request Leave' }));

    await waitFor(() => {
      expect(screen.getByText('End date must not be before start date.')).toBeTruthy();
    });
    expect(await listPendingActions()).toEqual([]);
  });

  it('accepts a valid date range and queues the action', async () => {
    // Submission also fires a best-effort background sync attempt - give
    // it a real (empty) response so it doesn't hit MSW's unhandled-request
    // guard, same pattern syncEngine.test.ts uses.
    server.use(http.post('*/v1/mobile/sync', () => HttpResponse.json({ results: [] })));

    await renderWithProviders(<LeaveRequestScreen />);

    await waitFor(() => screen.getByLabelText('Leave type ID'));

    await fireEvent.changeText(screen.getByLabelText('Leave type ID'), 'lt-1');
    await fireEvent.changeText(screen.getByLabelText('Start date'), '2026-09-01');
    await fireEvent.changeText(screen.getByLabelText('End date'), '2026-09-05');
    await fireEvent.press(screen.getByRole('button', { name: 'Request Leave' }));

    await waitFor(() => {
      expect(screen.getByText('Leave request queued.')).toBeTruthy();
    });
    const pending = await listPendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0].actionType).toBe('leave_request');
  });
});
