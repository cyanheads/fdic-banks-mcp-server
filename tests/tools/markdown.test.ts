/**
 * @fileoverview Tests for the format() helpers: inline flattening of upstream text
 * at every line break, line splitting, table-cell escaping, and unit-aware number
 * rendering.
 * @module tests/tools/markdown.test
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cell, inline, metricValue, num, splitLines } from '@/mcp-server/tools/markdown.js';

describe('markdown helpers', () => {
  it.each([
    '<b>*x*</b>',
    '[link](https://example.com)',
    '&amp; &#35; &lt;b&gt;',
    '`code` **bold** _italic_',
    'A\\|B',
    '## heading',
    '~~strike~~',
    '[x][ref]',
    'trailing #',
    'https://example.com/a-b?q=1 www.example.com user@example.com',
    'and_chr a_b_c ordinary, punctuation. a/b, c.d: e-f',
    'a+@example.com a.@example.com a-@example.com a!@example.com',
  ])('renders %j literally in GFM table, heading and bold slots', (text) => {
    const rendered = execFileSync(
      'bun',
      [
        '-e',
        'process.stdout.write(Bun.markdown.html(await Bun.stdin.text(), { autolinks: true }))',
      ],
      {
        input: `| ${cell(text)} |\n| --- |\n| ${cell(text)} |\n\n## ${inline(text)}\n\n**${inline(text)}**`,
        encoding: 'utf8',
      },
    );
    const escapedHtml = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(rendered).toContain(`<th>${escapedHtml}</th>`);
    expect(rendered).toContain(`<td>${escapedHtml}</td>`);
    expect(rendered).toContain(`<h2>${escapedHtml}</h2>`);
    expect(rendered).toContain(`<strong>${escapedHtml}</strong>`);
    expect(rendered.match(/<td>/g)).toHaveLength(1);
  });
  it('preserves ordinary punctuation and intraword underscores', () => {
    const text = 'and_chr a_b_c ordinary, punctuation. a/b, c.d: e-f';
    expect(inline(text)).toBe(text);
    expect(cell(text)).toBe(text);
  });

  it('suppresses email autolinks with punctuation at the end of the local part', () => {
    expect(inline('a+@example.com a.@example.com a-@example.com')).toBe(
      'a+\\@example.com a.\\@example.com a-\\@example.com',
    );
  });

  it.each([
    ['unclosed emphasis', (size: number) => '*a'.repeat(size / 2)],
    ['nested angle openers', (size: number) => '<a'.repeat(size / 2)],
    ['overlapping autolink prefixes', (size: number) => 'www.'.repeat(size / 4)],
    ['underscore runs', (size: number) => '_a'.repeat(size / 2)],
    ['long digits', (size: number) => '1'.repeat(size)],
  ] as const)('bounds thread CPU growth for %s', (shape, makeText) => {
    const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    const samples: number[] = [];
    for (const size of sizes) {
      const text = makeText(size);
      inline(text);
      const start = process.threadCpuUsage();
      for (let iteration = 0; iteration < 20; iteration++) inline(text);
      const cpu = process.threadCpuUsage(start);
      const microseconds = cpu.user + cpu.system;
      samples.push(microseconds);
      // Check the absolute CPU budget before attempting the next larger input.
      expect(microseconds).toBeLessThan(1_000_000);
    }
    expect((samples.at(-1) ?? 0) / Math.max(samples[0] ?? 0, 1)).toBeLessThan(256);
    console.info(JSON.stringify({ shape, sizes, threadCpuMicroseconds: samples }));
  });
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

  it('escapes backslashes in table cells, so an escaped pipe in the text stays inside one cell', () => {
    expect(cell('A\\|B')).toBe('A\\\\\\|B');
    expect(cell('C:\\path')).toBe('C:\\\\path');
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
