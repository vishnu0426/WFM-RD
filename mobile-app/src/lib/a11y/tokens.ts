/**
 * Every foreground/background pair here is asserted against WCAG 2.1 AA
 * (4.5:1 normal text / 3:1 large text & UI) in __tests__/contrast.test.ts —
 * do not add a new pair without adding it to that test's pair list too.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#F3F4F6',
  border: '#D1D5DB',

  textPrimary: '#1A1A1A',
  textSecondary: '#4B5563',

  primary: '#1D4ED8',
  onPrimary: '#FFFFFF',

  error: '#B91C1C',

  warningBackground: '#FEF3C7',
  warningText: '#78350F',
} as const;
