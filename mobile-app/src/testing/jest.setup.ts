import { server } from './mocks/server';

/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories
   and this file's CJS test setup run before ES module imports are hoisted,
   so both need require(), not import(); dynamic import() also isn't usable
   here without --experimental-vm-modules under babel-jest's CJS transform. */
jest.mock('expo-secure-store', () => require('./mocks/secureStore'));
jest.mock('expo-local-authentication', () => require('./mocks/biometric'));
jest.mock('@react-native-community/netinfo', () => require('./mocks/netInfo'));
// Full replacement, not a requireActual merge - see mocks/expo-notifications.ts's
// own doc comment for why (no jest-expo auto-mock exists for this module at all).
jest.mock('expo-notifications', () => require('./mocks/expo-notifications'));
// Same reasoning as expo-notifications above - see mocks/expo-location.ts's own doc comment.
jest.mock('expo-location', () => require('./mocks/expo-location'));
// Partial override - only randomUUID (see mocks/crypto.ts's own doc comment
// for why getRandomBytesAsync/digestStringAsync are deliberately untouched).
jest.mock('expo-crypto', () => ({
  ...jest.requireActual('expo-crypto'),
  ...require('./mocks/crypto'),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(async () => {
  server.resetHandlers();

  const { resetOAuthMockState } = require('./mocks/handlers');
  const secureStore = require('./mocks/secureStore');
  const biometric = require('./mocks/biometric');
  const netInfo = require('./mocks/netInfo');
  const expoNotifications = require('./mocks/expo-notifications');
  const expoLocation = require('./mocks/expo-location');
  const tokenGateway = require('@/auth/tokenGateway');
  // Raw require() (unlike app code's `import AsyncStorage from '...'`)
  // skips babel's default-export interop, so the mock's plain CJS export
  // is the object itself here, not `.default`.
  const AsyncStorage = require('@react-native-async-storage/async-storage');

  resetOAuthMockState();
  secureStore.__reset();
  biometric.__reset();
  netInfo.__reset();
  expoNotifications.__reset();
  expoLocation.__reset();
  tokenGateway.__resetForTests();
  await AsyncStorage.clear();
});
/* eslint-enable @typescript-eslint/no-require-imports */

afterAll(() => server.close());

process.env.EXPO_PUBLIC_DEV_EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:8000';
process.env.EXPO_PUBLIC_AUTH_API_BASE_URL = 'http://localhost:3000';
process.env.EXPO_PUBLIC_MOBILE_ESS_API_BASE_URL = 'http://localhost:8800';
process.env.EXPO_PUBLIC_EAS_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
process.env.EXPO_PUBLIC_INTRADAY_API_BASE_URL = 'http://localhost:8200';
process.env.EXPO_PUBLIC_ADHERENCE_COMPLIANCE_API_BASE_URL = 'http://localhost:8500';
process.env.EXPO_PUBLIC_ATTENDANCE_LEAVE_API_BASE_URL = 'http://localhost:8300';
