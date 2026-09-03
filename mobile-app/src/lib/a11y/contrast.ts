/** WCAG 2.1 contrast-ratio checker (docs/adr/0147). Formula per
 * https://www.w3.org/TR/WCAG21/#contrast-minimum */

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio ranges from 1 (no contrast) to 21 (black on white). */
export function contrastRatio(colorA: string, colorB: string): number {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.1 AA thresholds: 4.5:1 normal text, 3:1 large text (>=18pt or
 * >=14pt bold) and UI components/graphical objects. */
export function meetsWcagAA(
  foreground: string,
  background: string,
  options: { large?: boolean } = {},
): boolean {
  const threshold = options.large ? 3 : 4.5;
  return contrastRatio(foreground, background) >= threshold;
}
