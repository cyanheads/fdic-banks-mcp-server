/**
 * @fileoverview Tests for the format() helpers: inline flattening of upstream text
 * at every line break, line splitting, table-cell escaping, and unit-aware number
 * rendering.
 * @module tests/tools/markdown.test
 */

import { describe, expect, it } from 'vitest';
import { cell, inline, metricValue, num, splitLines } from '@/mcp-server/tools/markdown.js';

describe('markdown helpers', () => {
  it('flattens CR, LF, and CRLF to a space at inline slots', () => {
    expect(inline('A\r\nB\nC\rD')).toBe('A B C D');
  });

  it('flattens the other line breaks — VT, FF, NEL, LS, PS — to a space at inline slots', () => {
    expect(inline('A\vB\fC\u0085D\u{2028}E\u{2029}F')).toBe('A B C D E F');
    expect(cell('A|B\u{2028}C')).toBe('A\\|B C');
  });

  it('splits multi-line text at every line break, CRLF counting once', () => {
    expect(splitLines('A\r\nB\nC\rD\vE\fF\u0085G\u{2028}H\u{2029}I')).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
    ]);
  });

  it('flattens and escapes pipes in table cells', () => {
    expect(cell('A|B\nC')).toBe('A\\|B C');
  });

  it('renders numbers with separators and an em dash for absence', () => {
    expect(num(4091315000)).toBe('4,091,315,000');
    expect(num(1.23456)).toBe('1.23');
    expect(num(1.23456, 1)).toBe('1.2');
    expect(num(0)).toBe('0');
    expect(num(null)).toBe('—');
    expect(num(undefined)).toBe('—');
  });

  it('renders metric values by unit', () => {
    expect(metricValue(1.7125, 'percent')).toBe('1.71%');
    expect(metricValue(226846.4, 'count')).toBe('226,846');
    expect(metricValue(51234.567, 'usd_thousands')).toBe('51,234.57');
    expect(metricValue(0, 'percent')).toBe('0%');
    expect(metricValue(null, 'percent')).toBe('—');
  });
});
