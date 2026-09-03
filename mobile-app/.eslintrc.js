module.exports = {
  root: true,
  extends: ['expo', 'plugin:react-native-a11y/all', 'prettier'],
  plugins: ['react-native-a11y'],
  ignorePatterns: ['/dist/*', '/.expo/*', '/node_modules/*'],
  rules: {
    'react-native-a11y/has-valid-accessibility-descriptors': 'error',
    // accessibilityHint describes the *result of an action* (Apple/RN
    // guidance) — meaningful for interactive elements, not for passive
    // status/text/progress content. The blanket "all" preset flags both;
    // narrowed here rather than papering over it with per-line disables.
    'react-native-a11y/has-accessibility-hint': 'off',
  },
};
