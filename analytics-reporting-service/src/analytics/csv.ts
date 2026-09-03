/**
 * Own copy of adherence-compliance-service's `csv.ts` (ADR-0039 precedent;
 * that file's own doc comment - docs/adr/0105 - already established that
 * no CSV/spreadsheet library exists anywhere in this platform, deliberately,
 * for a format this simple). RFC 4180-shaped: a field is quoted only when
 * it contains a comma, quote, or newline, and an embedded quote is escaped
 * by doubling it.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [headers, ...rows].map((row) => row.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

function csvField(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
