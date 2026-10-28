/**
 * @fileoverview Markdown rendering helpers for format(): render upstream free text
 * literally at inline slots and table cells, split multi-line text, and render
 * numbers with units, so content[] carries the same values as structuredContent.
 * @module mcp-server/tools/markdown
 */

import type { MetricUnit } from '@/services/fdic/metric-catalog.js';

/**
 * Every Unicode line break: CRLF as one, then LF, VT, FF, CR, NEL, LS, and PS. A reader
 * that sees any of them as a new line would otherwise see text leave its slot.
 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u{2028}\u{2029}]/gu;

/**
 * A string Markdown cannot carry as plain text: empty, whitespace at either edge (which
 * table cells and headings trim and which breaks emphasis flanking), or any line break.
 */
const NOT_PLAIN = new RegExp(`^$|^\\s|\\s$|${LINE_BREAK.source}`, 'u');

/** The line breaks `JSON.stringify` leaves raw. */
const RAW_JSON_BREAK = /[\u0085\u{2028}\u{2029}]/gu;

/**
 * A string that is not plain text, as its JSON literal in a code span on one line: the
 * reader `JSON.parse`s the span's text back to the original. In a table cell `|` is
 * written `\|`, which GFM unescapes inside code spans too.
 */
function jsonCodeSpan(text: string, inTable: boolean): string {
  let json = JSON.stringify(text).replace(
    RAW_JSON_BREAK,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  if (inTable) json = json.replaceAll('|', '\\|');
  // A fence longer than every backtick run inside cannot close early. JSON opens and
  // closes with a quote, so the span needs no padding space.
  let longestRun = 0;
  for (const run of json.matchAll(/`+/g)) longestRun = Math.max(longestRun, run[0].length);
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${json}${fence}`;
}

/**
 * Plain text with active Markdown escaped once. Backticks are escaped, so a code span
 * in rendered output only ever comes from `jsonCodeSpan`.
 */
function escapePlain(text: string): string {
  return text.replace(
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

/**
 * Upstream text rendered literally in inline, heading, and bold-label slots. A string
 * with a line break, edge whitespace, or no characters renders as its JSON literal in a
 * code span; any other string renders as escaped text.
 */
export function inline(text: string): string {
  return NOT_PLAIN.test(text) ? jsonCodeSpan(text, false) : escapePlain(text);
}

/** Multi-line text split at every line break, for a renderer that prefixes each line. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * `inline()` for a table cell. Plain text escapes `\` and `|` in the same single pass,
 * so an escaped pipe in the text stays inside one cell.
 */
export function cell(text: string): string {
  return NOT_PLAIN.test(text) ? jsonCodeSpan(text, true) : escapePlain(text);
}

/**
 * Shortest round-trip digits — the digits `String(n)` and JSON carry — in positional
 * notation with en-US grouping. 100 is ECMA-402's maximum fraction-digit count.
 */
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 100 });

/** A number with thousands separators and every digit JSON carries; `—` when absent. */
export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  // `+ 0` turns -0 into 0, as JSON writes it.
  return NUMBER.format(value + 0);
}

/** A metric value with its unit: `1.7125%`, `4,091,315,000` (USD thousands), `77.5`. */
export function metricValue(value: number | null | undefined, unit?: MetricUnit): string {
  if (value === null || value === undefined) return '—';
  return unit === 'percent' ? `${num(value)}%` : num(value);
}
