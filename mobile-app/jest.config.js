// Spreading the resolved jest-expo preset (rather than `preset: 'jest-expo'`)
// so we can extend its `transform` map with an `.mjs` entry — MSW's `native`
// entrypoint and some of its transitive deps (e.g. `rettime`) ship ESM-only
// `.mjs` files, which jest-expo's own transform regex (`\.[jt]sx?$`) doesn't
// cover, causing "Cannot use import statement outside a module".
const jestExpoPreset = require('jest-expo/jest-preset');

/** @type {import('jest').Config} */
module.exports = {
  ...jestExpoPreset,
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': jestExpoPreset.transform['\\.[jt]sx?$'],
  },
  setupFilesAfterEnv: [
    ...(jestExpoPreset.setupFilesAfterEnv || []),
    '<rootDir>/src/testing/jest.setup.ts',
  ],
  transformIgnorePatterns: [
    // Default RN preset exceptions, plus MSW and its ESM-only transitive
    // deps (msw/native is used for the offline-friendly test network mocks).
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|msw|@mswjs/.*|@open-draft/.*|@bundled-es-modules/.*|rettime|headers-polyfill|outvariant|strict-event-emitter|until-async|is-node-process|path-to-regexp)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/testing/**'],
};
