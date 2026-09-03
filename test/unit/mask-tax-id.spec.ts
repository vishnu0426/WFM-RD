import { maskTaxId } from '../../src/modules/employee/util/mask-tax-id';

describe('maskTaxId', () => {
  it('returns null when no Tax ID is set', () => {
    expect(maskTaxId(null)).toBeNull();
  });

  it('masks everything but the last 4 characters', () => {
    expect(maskTaxId('123-45-6789')).toBe('•••-••-6789');
  });

  it('never includes any digit from earlier in the value', () => {
    const masked = maskTaxId('987654321');
    expect(masked).toBe('•••-••-4321');
    expect(masked).not.toContain('987');
  });
});
