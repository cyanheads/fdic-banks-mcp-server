/**
 * @fileoverview Tests for the shared input-schema blocks: blank-as-unset
 * preprocessing, report-date and calendar-date patterns, the state length bound,
 * and the metric enum.
 * @module tests/tools/input-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  calendarDateInput,
  metricEnum,
  reportDateInput,
  stateInput,
} from '@/mcp-server/tools/input-schemas.js';

describe('blankAsUnset', () => {
  const schema = z.object({
    text: blankAsUnset(z.string().optional()),
    choice: blankAsUnset(z.enum(['a', 'b']).default('a')),
    amount: blankAsUnset(z.number().optional()),
  });

  it('reads blank and whitespace-only strings as unset, so defaults apply', () => {
    expect(schema.parse({ text: '', choice: '   ', amount: '' })).toEqual({ choice: 'a' });
  });

  it('trims other strings before the inner schema validates them', () => {
    expect(schema.parse({ text: '  hi  ', choice: ' b ' })).toEqual({ text: 'hi', choice: 'b' });
  });

  it('still rejects values the inner schema rejects', () => {
    expect(schema.safeParse({ choice: 'c' }).success).toBe(false);
    expect(schema.safeParse({ amount: 'ten' }).success).toBe(false);
  });
});

describe('date inputs', () => {
  const report = reportDateInput('d');
  const calendar = calendarDateInput('d');

  it('accepts quarter-end dates in all three forms and blank as unset', () => {
    for (const value of ['2026-06-30', '20260630', '2026Q2', '2026-q2']) {
      expect(report.parse(value)).toBe(value);
    }
    expect(report.parse('')).toBeUndefined();
    expect(report.parse(' ')).toBeUndefined();
  });

  it('rejects a non-quarter-end date rather than snapping it to a quarter', () => {
    for (const value of ['2026-06-29', '2026-07-01', '20260631', '2026Q5', 'Q2 2026']) {
      expect(report.safeParse(value).success).toBe(false);
    }
  });

  it('accepts YYYY-MM-DD calendar dates and rejects other shapes', () => {
    expect(calendar.parse('2023-03-10')).toBe('2023-03-10');
    expect(calendar.parse('')).toBeUndefined();
    for (const value of ['3/10/2023', '2023-3-10', '2023-00-10', '2023-03-32', '20230310']) {
      expect(calendar.safeParse(value).success).toBe(false);
    }
  });
});

describe('stateInput', () => {
  const state = stateInput('s');

  it('takes up to 50 characters after trimming, and blank as unset', () => {
    expect(state.parse('Northern Mariana Islands')).toBe('Northern Mariana Islands');
    expect(state.parse(` ${'x'.repeat(50)} `)).toBe('x'.repeat(50));
    expect(state.parse('')).toBeUndefined();
  });

  it('rejects 51 characters at the schema, before a handler could echo them', () => {
    expect(state.safeParse('x'.repeat(51)).success).toBe(false);
  });
});

describe('metricEnum', () => {
  it('takes catalog names exactly', () => {
    expect(metricEnum.parse('cet1_ratio')).toBe('cet1_ratio');
    expect(metricEnum.safeParse('CET1_RATIO').success).toBe(false);
    expect(metricEnum.safeParse('IDT1CER').success).toBe(false);
  });
});
