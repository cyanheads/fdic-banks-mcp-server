/**
 * @fileoverview Tests for the format() helpers: inline flattening of upstream text,
 * table-cell escaping, and unit-aware number rendering.
 * @module tests/tools/markdown.test
 */

import { describe, expect, it } from 'vitest';
import { cell, inline, metricValue, num } from '@/mcp-server/tools/markdown.js';

describe('markdown helpers', () => {
  it('flattens CR, LF, and CRLF to a space at inline slots', () => {
    expect(inline('A\r\nB\nC\rD')).toBe('A B C D');
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
