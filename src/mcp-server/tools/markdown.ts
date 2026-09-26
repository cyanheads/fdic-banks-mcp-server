/**
 * @fileoverview Markdown rendering helpers for format(): flatten upstream free text
 * at inline slots, split multi-line text, escape table cells, and render numbers
 * with units.
 * @module mcp-server/tools/markdown
 */

import type { MetricUnit } from '@/services/fdic/metric-catalog.js';

/**
 * Every Unicode line break: CRLF as one, then LF, VT, FF, CR, NEL, LS, and PS. A reader
 * that sees any of them as a new line would otherwise see text leave its slot.
 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u{2028}\u{2029}]/gu;

/** Upstream text at an inline slot (heading, bold label, list item): line breaks flattened to a space. */
export function inline(text: string): string {
  return text.replace(LINE_BREAK, ' ');
}

/** Multi-line text split at every line break, for a renderer that prefixes each line. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** Upstream text in a table cell: flattened, with pipes escaped. */
export function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

/** A number with thousands separators and at most `maxFraction` decimals; `—` when absent. */
export function num(value: number | null | undefined, maxFraction = 2): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

/** A metric value with its unit: `1.71%`, `4,091,315,000` (USD thousands), `226,846`. */
export function metricValue(value: number | null | undefined, unit?: MetricUnit): string {
  if (value === null || value === undefined) return '—';
  if (unit === 'percent') return `${num(value)}%`;
  return num(value, unit === 'count' ? 0 : 2);
}
