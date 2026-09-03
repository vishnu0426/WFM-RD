/**
 * docs/adr/0105: no CSV or spreadsheet library exists anywhere in this
 * platform - this is deliberately a plain, dependency-free builder rather
 * than pulling one in for a format this simple. RFC 4180-shaped: a field
 * is quoted only when it contains a comma, quote, or newline (a bare
 * numeric/plain-text field is left unquoted, matching every spreadsheet
 * tool's own round-trip expectation), and an embedded quote is escaped by
 * doubling it.
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
