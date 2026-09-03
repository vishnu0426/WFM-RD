import { http, HttpResponse } from 'msw';

import { ShiftAssignment } from '@/api/types';
import { AccessTokenClaims } from '@/auth/jwt';

/**
 * Shape hand-verified against scheduling-service's `EmployeeShiftAssignmentResponse`
 * (scheduling-service/app/api/v1/schemas.py) — not guessed.
 */
export const mockShiftAssignment: ShiftAssignment = {
  id: '11111111-1111-4111-8111-111111111111',
  employeeId: '22222222-2222-4222-8222-222222222222',
  scheduleId: '33333333-3333-4333-8333-333333333333',
  shiftStart: '2026-08-14T13:00:00Z',
  shiftEnd: '2026-08-14T21:00:00Z',
  skillId: null,
  assignmentSource: 'manual',
  isOvertime: false,
  locked: false,
  publishedAt: '2026-08-10T09:00:00Z',
};

/** Matches the seeded demo user (src/database/seeds/run-seed.ts). */
export const MOCK_USERNAME = 'admin@acme-demo.example';
export const MOCK_PASSWORD = 'ChangeMe123!';
export const MOCK_TENANT_ID = '44444444-4444-4444-8444-444444444444';

function base64UrlEncode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Only runs inside Jest (Node), never on-device — safe to use `Buffer`
 * here even though app code never assumes it's globally available. */
export function buildMockAccessToken(overrides: Partial<AccessTokenClaims> = {}): string {
  const header = base64UrlEncode({ alg: 'RS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode({
    iss: 'https://auth.agno-wfm.local',
    sub: 'mock-user-id',
    aud: 'wfm-mobile-app',
    tenant_id: MOCK_TENANT_ID,
    org_unit_id: null,
    roles: ['tenant_admin'],
    permissions: [],
    amr: ['pwd'],
    jti: 'mock-jti',
    exp: now + 720,
    iat: now,
    ...overrides,
  });
  return `${header}.${payload}.mock-signature`;
}

export const INITIAL_REFRESH_TOKEN = 'mock-refresh-token-1';
let validRefreshToken: string = INITIAL_REFRESH_TOKEN;
let refreshGeneration = 1;

/** Call between tests that exercise the refresh-rotation flow. */
export function resetOAuthMockState(): void {
  validRefreshToken = INITIAL_REFRESH_TOKEN;
  refreshGeneration = 1;
}

const oauthHandlers = [
  http.post('*/oauth/authorize', async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string; state?: string };
    if (body.username === MOCK_USERNAME && body.password === MOCK_PASSWORD) {
      return HttpResponse.json({ code: 'mock-auth-code', state: body.state ?? null });
    }
    return HttpResponse.json(
      { error: 'invalid_grant', error_description: 'Incorrect username or password.' },
      { status: 400 },
    );
  }),

  http.post('*/oauth/token', async ({ request }) => {
    const body = (await request.json()) as { grant_type?: string; code?: string; refresh_token?: string };

    if (body.grant_type === 'authorization_code') {
      if (body.code !== 'mock-auth-code') {
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Invalid authorization code.' },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: buildMockAccessToken(),
        token_type: 'Bearer',
        expires_in: 720,
        refresh_token: validRefreshToken,
        scope: '',
      });
    }

    if (body.grant_type === 'refresh_token') {
      if (body.refresh_token !== validRefreshToken) {
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Refresh token is invalid.' },
          { status: 400 },
        );
      }
      refreshGeneration += 1;
      validRefreshToken = `mock-refresh-token-${refreshGeneration}`;
      return HttpResponse.json({
        access_token: buildMockAccessToken(),
        token_type: 'Bearer',
        expires_in: 720,
        refresh_token: validRefreshToken,
        refresh_token_expires_in: 2_592_000,
        scope: '',
      });
    }

    return HttpResponse.json(
      { error: 'unsupported_grant_type', error_description: 'Unsupported grant type.' },
      { status: 400 },
    );
  }),

  http.post('*/graphql', () => {
    return HttpResponse.json({
      data: {
        me: { id: 'mock-user-id', email: MOCK_USERNAME, givenName: 'Demo', familyName: 'Admin' },
      },
    });
  }),
];

export const handlers = [
  http.get('*/v1/scheduling/employees/:employeeId/shift-assignments', () => {
    return HttpResponse.json([mockShiftAssignment]);
  }),
  // Default: geofencing not configured for any test tenant/org unit -
  // ClockInOutControls' own useGeofenceGate() calls this on every mount
  // (docs/adr/0155); tests that need the disclosure gate active override
  // this with server.use(...).
  http.get('*/v1/mobile/geofence-config', () => {
    return HttpResponse.json({ enabled: false });
  }),
  ...oauthHandlers,
];
