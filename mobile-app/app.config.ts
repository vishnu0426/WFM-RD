import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'AGNO WFM',
  slug: 'agno-wfm-mobile',
  scheme: 'agnowfm',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-local-authentication',
      {
        faceIDPermission: 'Use Face ID to unlock AGNO WFM.',
      },
    ],
    [
      'expo-notifications',
      {
        // Reuses the existing Android adaptive-icon monochrome variant
        // (already a white-on-transparent silhouette) rather than
        // designing a dedicated notification icon asset this phase.
        icon: './assets/android-icon-monochrome.png',
        // Matches colors.primary (src/lib/a11y/tokens.ts) - the same brand
        // color used everywhere else in the app.
        color: '#1D4ED8',
        defaultChannel: 'default',
      },
    ],
    [
      'expo-location',
      {
        // Foreground-only, one-shot capture at the moment of a clock-in/
        // out tap (docs/adr/0155) - no background location, so only this
        // one permission string is set; isAndroidBackgroundLocationEnabled/
        // isIosBackgroundLocationEnabled default to false.
        locationWhenInUsePermission:
          'AGNO WFM uses your location only at the moment you clock in or out, to verify you are within your site\'s configured boundary.',
      },
    ],
  ],
};

export default config;
