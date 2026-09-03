import { http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';

import { listConflicts } from '../conflicts';
import { syncPendingActions } from '../syncEngine';
import {
  enqueueAction,
  listPendingActions,
  QueuedClockEventAction,
  QueuedLeaveRequestAction,
  QueuedMarketplaceClaimAction,
} from '../storage';

const SYNC_URL = '*/v1/mobile/sync';

function buildClockEventAction(overrides: Partial<QueuedClockEventAction> = {}): QueuedClockEventAction {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    actionType: 'clock_event',
    payload: { eventType: 'clock_in' },
    createdAtDevice: '2026-08-14T09:00:00.000Z',
    ...overrides,
  };
}

function buildLeaveRequestAction(overrides: Partial<QueuedLeaveRequestAction> = {}): QueuedLeaveRequestAction {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    actionType: 'leave_request',
    payload: { leaveTypeId: 'lt-1', dateRangeStart: '2026-09-01', dateRangeEnd: '2026-09-05' },
    createdAtDevice: '2026-08-14T09:00:00.000Z',
    ...overrides,
  };
}

function buildMarketplaceClaimAction(
  overrides: Partial<QueuedMarketplaceClaimAction> = {},
): QueuedMarketplaceClaimAction {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    actionType: 'marketplace_claim',
    payload: { marketplacePostId: 'post-1' },
    createdAtDevice: '2026-08-14T09:00:00.000Z',
    ...overrides,
  };
}

const CONTEXT = {
  tenantId: '44444444-4444-4444-8444-444444444444',
  employeeId: '22222222-2222-4222-8222-222222222222',
  mobileEssApiBaseUrl: 'http://localhost:8800',
};

describe('syncPendingActions', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('does nothing when the queue is empty (no request made)', async () => {
    let requestCount = 0;
    server.use(
      http.post(SYNC_URL, () => {
        requestCount += 1;
        return HttpResponse.json({ results: [] });
      }),
    );

    await syncPendingActions(CONTEXT);

    expect(requestCount).toBe(0);
  });

  it('removes a synced action from the local queue', async () => {
    const action = buildClockEventAction();
    await enqueueAction(action);
    server.use(
      http.post(SYNC_URL, () =>
        HttpResponse.json({ results: [{ actionId: action.id, actionType: action.actionType, status: 'synced' }] }),
      ),
    );

    await syncPendingActions(CONTEXT);

    expect(await listPendingActions()).toEqual([]);
  });

  it('moves a conflicted clock_event action to the conflicts store, tagged with its actionType', async () => {
    const action = buildClockEventAction();
    await enqueueAction(action);
    server.use(
      http.post(SYNC_URL, () =>
        HttpResponse.json({
          results: [
            {
              actionId: action.id,
              actionType: action.actionType,
              status: 'conflict',
              conflictDetails: { code: 'ATTENDANCE_NO_OPEN_RECORD', message: 'No open clock-in.' },
            },
          ],
        }),
      ),
    );

    await syncPendingActions(CONTEXT);

    expect(await listPendingActions()).toEqual([]);
    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id: action.id,
      actionType: 'clock_event',
      code: 'ATTENDANCE_NO_OPEN_RECORD',
      message: 'No open clock-in.',
    });
  });

  it('moves a conflicted leave_request action to the conflicts store, tagged with its actionType', async () => {
    const action = buildLeaveRequestAction();
    await enqueueAction(action);
    server.use(
      http.post(SYNC_URL, () =>
        HttpResponse.json({
          results: [
            {
              actionId: action.id,
              actionType: action.actionType,
              status: 'conflict',
              conflictDetails: { code: 'INSUFFICIENT_LEAVE_BALANCE', message: 'Not enough leave balance.' },
            },
          ],
        }),
      ),
    );

    await syncPendingActions(CONTEXT);

    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ id: action.id, actionType: 'leave_request', code: 'INSUFFICIENT_LEAVE_BALANCE' });
  });

  it('moves a conflicted marketplace_claim action to the conflicts store, tagged with its actionType', async () => {
    const action = buildMarketplaceClaimAction();
    await enqueueAction(action);
    server.use(
      http.post(SYNC_URL, () =>
        HttpResponse.json({
          results: [
            {
              actionId: action.id,
              actionType: action.actionType,
              status: 'conflict',
              conflictDetails: { code: 'POST_NOT_OPEN', message: "This shift's status changed while you were offline." },
            },
          ],
        }),
      ),
    );

    await syncPendingActions(CONTEXT);

    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ id: action.id, actionType: 'marketplace_claim', code: 'POST_NOT_OPEN' });
  });

  it('leaves a failed action queued for retry', async () => {
    const action = buildClockEventAction();
    await enqueueAction(action);
    server.use(
      http.post(SYNC_URL, () =>
        HttpResponse.json({
          results: [{ actionId: action.id, actionType: action.actionType, status: 'failed', detail: 'unreachable' }],
        }),
      ),
    );

    await syncPendingActions(CONTEXT);

    const pending = await listPendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(action.id);
  });

  it('leaves every action in a batch queued when the whole request fails (network error), without throwing', async () => {
    const action = buildClockEventAction();
    await enqueueAction(action);
    server.use(http.post(SYNC_URL, () => HttpResponse.error()));

    await expect(syncPendingActions(CONTEXT)).resolves.toBeUndefined();

    const pending = await listPendingActions();
    expect(pending).toHaveLength(1);
  });

  it('sends a mixed batch of all three action types, each queued and forwarded correctly', async () => {
    const clockEvent = buildClockEventAction();
    const leaveRequest = buildLeaveRequestAction();
    const marketplaceClaim = buildMarketplaceClaimAction();
    await enqueueAction(clockEvent);
    await enqueueAction(leaveRequest);
    await enqueueAction(marketplaceClaim);

    let sentTypes: string[] = [];
    server.use(
      http.post(SYNC_URL, async ({ request }) => {
        const body = (await request.json()) as { actions: { id: string; actionType: string }[] };
        sentTypes = body.actions.map((a) => a.actionType);
        return HttpResponse.json({
          results: body.actions.map((a) => ({ actionId: a.id, actionType: a.actionType, status: 'synced' })),
        });
      }),
    );

    await syncPendingActions(CONTEXT);

    expect(sentTypes.sort()).toEqual(['clock_event', 'leave_request', 'marketplace_claim']);
    expect(await listPendingActions()).toEqual([]);
  });

  it('sends actions to the server in createdAtDevice order', async () => {
    const later = buildClockEventAction({ id: 'later', createdAtDevice: '2026-08-14T12:00:00.000Z' });
    const earlier = buildClockEventAction({ id: 'earlier', createdAtDevice: '2026-08-14T09:00:00.000Z' });
    // Enqueued out of order on purpose.
    await enqueueAction(later);
    await enqueueAction(earlier);

    let sentIds: string[] = [];
    server.use(
      http.post(SYNC_URL, async ({ request }) => {
        const body = (await request.json()) as { actions: { id: string; actionType: string }[] };
        sentIds = body.actions.map((a) => a.id);
        return HttpResponse.json({
          results: body.actions.map((a) => ({ actionId: a.id, actionType: a.actionType, status: 'synced' })),
        });
      }),
    );

    await syncPendingActions(CONTEXT);

    expect(sentIds).toEqual(['earlier', 'later']);
  });
});
