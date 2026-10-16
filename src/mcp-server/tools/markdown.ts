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

/** Upstream text rendered literally in inline, heading, bold-label, and table slots. */
export function inline(text: string): string {
  return text
    .replace(LINE_BREAK, ' ')
    .replace(
      /[\\`*_[\]<>&#|~@]|(?<=[a-z]):(?=\/\/)|(?<=www)\./gi,
      (character: string, index: number, whole: string) => {
        // GFM leaves underscores between letters or digits inert.
        if (
          character === '_' &&
          /[\p{L}\p{N}]/u.test(whole[index - 1] ?? '') &&
          /[\p{L}\p{N}]/u.test(whole[index + 1] ?? '')
        )
          return character;
        return `\\${character}`;
      },
    );
}

/** Multi-line text split at every line break, for a renderer that prefixes each line. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * Reuse inline escaping once: a second backslash pass would reactivate table pipes.
 */
export function cell(text: string): string {
  return inline(text);
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
