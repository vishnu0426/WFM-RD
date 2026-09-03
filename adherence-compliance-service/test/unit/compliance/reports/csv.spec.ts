import { toCsv } from '../../../../src/compliance/reports/csv';

describe('toCsv', () => {
  it('joins headers and rows with CRLF, matching RFC 4180', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toBe('a,b\r\n1,2\r\n3,4\r\n');
  });

  it('leaves plain fields unquoted', () => {
    expect(toCsv(['name'], [['plain text']])).toBe('name\r\nplain text\r\n');
  });

  it('quotes a field containing a comma', () => {
    expect(toCsv(['name'], [['Doe, Jane']])).toBe('name\r\n"Doe, Jane"\r\n');
  });

  it('quotes a field containing a double quote and doubles it', () => {
    expect(toCsv(['note'], [['she said "hi"']])).toBe('note\r\n"she said ""hi"""\r\n');
  });

  it('quotes a field containing a newline', () => {
    expect(toCsv(['note'], [['line1\nline2']])).toBe('note\r\n"line1\nline2"\r\n');
  });

  it('produces just a header row with no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });
});
