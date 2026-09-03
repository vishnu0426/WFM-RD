import { delay, http, HttpResponse } from 'msw';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { server } from '@/testing/mocks/server';
import { renderWithProviders, screen, waitFor } from '@/testing/test-utils';
import { AdherenceScoreToday, AgentLiveState } from '@/api/types';

import { AdherenceScreen } from '../AdherenceScreen';

const LIVE_STATE_URL = 'http://localhost:8200/graphql';
const SCORE_URL = 'http://localhost:8500/graphql';

const LIVE_STATE_FIXTURE: AgentLiveState = {
  employeeId: '22222222-2222-4222-8222-222222222222',
  currentActivity: 'available',
  activityStartedAt: '2026-08-14T09:00:00.000Z',
  scheduledActivity: 'available',
  adherenceStatus: 'adherent',
  siteId: 'site-1',
  queueId: 'queue-1',
  dataFreshness: { status: 'ok', lastKnownUpdateAt: '2026-08-14T09:05:00.000Z' },
};

const SCORE_FIXTURE: AdherenceScoreToday = {
  employeeId: '22222222-2222-4222-8222-222222222222',
  periodStart: '2026-08-14T00:00:00.000Z',
  periodEnd: '2026-08-15T00:00:00.000Z',
  adherencePct: 92.5,
  majorDeviationCount: 1,
  adherentSeconds: 3600,
  totalScheduledSeconds: 3900,
  computedAt: '2026-08-14T10:00:00.000Z',
};

function mockLiveState(data: AgentLiveState | null) {
  server.use(http.post(LIVE_STATE_URL, () => HttpResponse.json({ data: { agentLiveState: data } })));
}

function mockScore(data: AdherenceScoreToday | null) {
  server.use(http.post(SCORE_URL, () => HttpResponse.json({ data: { adherenceScoreToday: data } })));
}

describe('AdherenceScreen', () => {
  beforeEach(async () => {
    await seedAuthenticatedSession();
  });

  it('renders both sections independently once loaded', async () => {
    mockLiveState(LIVE_STATE_FIXTURE);
    mockScore(SCORE_FIXTURE);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => screen.getByText('available'));
    await waitFor(() => screen.getByText('92.5%'));
  });

  it('shows a loading state for the live-status section independently of the adherence section', async () => {
    server.use(
      http.post(LIVE_STATE_URL, async () => {
        await delay('infinite');
        return HttpResponse.json({ data: { agentLiveState: LIVE_STATE_FIXTURE } });
      }),
    );
    mockScore(SCORE_FIXTURE);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText('Loading your current status')).toBeTruthy();
      expect(screen.getByText('92.5%')).toBeTruthy();
    });
  });

  it('shows an empty state for live status when no data exists, without affecting the adherence section', async () => {
    mockLiveState(null);
    mockScore(SCORE_FIXTURE);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => {
      expect(screen.getByText('No live status available')).toBeTruthy();
      expect(screen.getByText('92.5%')).toBeTruthy();
    });
  });

  it('shows an empty state for adherence when no activity has been recorded yet today', async () => {
    mockLiveState(LIVE_STATE_FIXTURE);
    mockScore(null);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => {
      expect(screen.getByText('No adherence activity recorded yet today')).toBeTruthy();
      expect(screen.getByText('available')).toBeTruthy();
    });
  });

  it('shows a retryable error for one section while the other still succeeds', async () => {
    server.use(http.post(LIVE_STATE_URL, () => HttpResponse.error()));
    mockScore(SCORE_FIXTURE);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your current status")).toBeTruthy();
      expect(screen.getByText('92.5%')).toBeTruthy();
    });
  });

  it('shows a "data may be delayed" note when the live status is degraded', async () => {
    mockLiveState({
      ...LIVE_STATE_FIXTURE,
      dataFreshness: { status: 'degraded', lastKnownUpdateAt: null },
    });
    mockScore(SCORE_FIXTURE);

    await renderWithProviders(<AdherenceScreen />);

    await waitFor(() => screen.getByText('Data may be delayed'));
  });
});
