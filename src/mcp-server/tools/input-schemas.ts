/**
 * @fileoverview Input schema building blocks shared by the fdic_ tools: blank-as-unset
 * wrapping for form clients, the report-date and calendar-date fields, and the
 * metric-name enum.
 * @module mcp-server/tools/input-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { METRIC_NAMES } from '@/services/fdic/metric-catalog.js';
import { CALENDAR_DATE_PATTERN, REPORT_DATE_PATTERN } from '@/services/fdic/query-builder.js';

/**
 * Form clients submit every optional field. A blank or whitespace-only string is
 * "unset", and any other string is trimmed before the inner schema validates it.
 */
export function blankAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, schema);
}

/** Optional quarter-end `report_date` input; converted with `reportDateToIso` in the handler. */
export function reportDateInput(description: string) {
  return blankAsUnset(
    z
      .string()
      .regex(
        REPORT_DATE_PATTERN,
        'Expected a quarter-end date (YYYY-03-31, YYYY-06-30, YYYY-09-30, YYYY-12-31), the same without dashes, or a quarter label such as 2026Q2',
      )
      .optional(),
  ).describe(description);
}

/** Optional `YYYY-MM-DD` calendar-date input; the handler checks the day exists in its month. */
export function calendarDateInput(description: string) {
  return blankAsUnset(
    z.string().regex(CALENDAR_DATE_PATTERN, 'Expected a calendar date as YYYY-MM-DD').optional(),
  ).describe(description);
}

/** One metric name from the curated catalog (fdic_list_reference topic metrics). */
export const metricEnum = z
  .enum(METRIC_NAMES)
  .describe('Metric name from the catalog, e.g. roa, net_income_ytd, cet1_ratio.');

/** Optional free-text `state` input: a two-letter code in any case or a full name. */
export function stateInput(description: string) {
  return blankAsUnset(z.string().optional()).describe(description);
}
