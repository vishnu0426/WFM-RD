import { meetsWcagAA } from '@/lib/a11y/contrast';
import { colors } from '@/lib/a11y/tokens';

describe('design token contrast pairs meet WCAG 2.1 AA', () => {
  const normalTextPairs = [
    { description: 'textPrimary on background', fg: colors.textPrimary, bg: colors.background },
    {
      description: 'textSecondary on background',
      fg: colors.textSecondary,
      bg: colors.background,
    },
    { description: 'textPrimary on surface', fg: colors.textPrimary, bg: colors.surface },
    { description: 'textSecondary on surface', fg: colors.textSecondary, bg: colors.surface },
    { description: 'onPrimary on primary', fg: colors.onPrimary, bg: colors.primary },
    { description: 'error on background', fg: colors.error, bg: colors.background },
    {
      description: 'warningText on warningBackground',
      fg: colors.warningText,
      bg: colors.warningBackground,
    },
  ];

  it.each(normalTextPairs)('$description meets 4.5:1', ({ fg, bg }) => {
    expect(meetsWcagAA(fg, bg)).toBe(true);
  });
});
