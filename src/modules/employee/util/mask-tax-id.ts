/** `null` (unset) stays `null`; otherwise only the last 4 characters survive — the rest is never reconstructible from what this returns. */
export function maskTaxId(taxId: string | null): string | null {
  if (!taxId) {
    return null;
  }
  const last4 = taxId.slice(-4);
  return `•••-••-${last4}`;
}
