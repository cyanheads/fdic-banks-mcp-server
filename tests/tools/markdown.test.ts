/**
 * @fileoverview Tests for the format() helpers: literal rendering of upstream text at
 * inline slots and table cells (escaped plain text, or a JSON code span for text with
 * line breaks, edge whitespace, or no characters), line splitting, and number rendering
 * that carries every digit structuredContent does.
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
  it.each([
    ['LF', 'line1\nline2', '`"line1\\nline2"`', '`"line1\\nline2"`'],
    ['CRLF', 'a\r\nb', '`"a\\r\\nb"`', '`"a\\r\\nb"`'],
    ['CR', 'a\rb', '`"a\\rb"`', '`"a\\rb"`'],
    ['VT and FF', 'a\vb\fc', '`"a\\u000bb\\fc"`', '`"a\\u000bb\\fc"`'],
    [
      'NEL, LS, and PS',
      'a\u0085b\u{2028}c\u{2029}d',
      '`"a\\u0085b\\u2028c\\u2029d"`',
      '`"a\\u0085b\\u2028c\\u2029d"`',
    ],
    ['the empty string', '', '`""`', '`""`'],
    ['edge spaces', ' padded ', '`" padded "`', '`" padded "`'],
    ['a leading tab', '\tx', '`"\\tx"`', '`"\\tx"`'],
    ['a pipe and a break', 'x|y\nz', '`"x|y\\nz"`', '`"x\\|y\\nz"`'],
    ['a backtick and a break', 'tick`s\nnext', '``"tick`s\\nnext"``', '``"tick`s\\nnext"``'],
    ['a backtick run', 'a```b\n', '````"a```b\\n"````', '````"a```b\\n"````'],
    ['an escaped pipe and a break', 'A\\|B\n2', '`"A\\\\|B\\n2"`', '`"A\\\\\\|B\\n2"`'],
  ])('renders text with %s as a one-line JSON code span', (_label, text, inlined, celled) => {
    expect(inline(text)).toBe(inlined);
    expect(cell(text)).toBe(celled);
  });

  it.each([
    'line1\nline2',
    'a\r\nb',
    '',
    ' padded ',
    'x|y\nz',
    'tick`s\nnext',
    'nel\u0085ls\u{2028}ps\u{2029}end',
    'A\\|B\n2',
    'a\vb\fc\rd',
    ' nbsp edge',
    '<b>*x*</b>\n[l](https://e.com) &amp; ```',
  ])('round-trips %j through a code span in parsed GFM table, heading and bold slots', (text) => {
    const markdown = `| ${cell(text)} |\n| --- |\n| ${cell(text)} |\n\n## ${inline(text)}\n\n**${inline(text)}**`;
    // No rendered value adds a line: the document splits into exactly the seven lines written.
    expect(markdown.split(/\r\n|[\n\v\f\r\u0085\u{2028}\u{2029}]/u)).toHaveLength(7);
    const rendered = execFileSync(
      'bun',
      [
        '-e',
        'process.stdout.write(Bun.markdown.html(await Bun.stdin.text(), { autolinks: true }))',
      ],
      { input: markdown, encoding: 'utf8' },
    );
    const decode = (html: string) =>
      JSON.parse(
        html
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
      );
    // The whole slot is one code span, so its text is the JSON literal and nothing else.
    const slots = [...rendered.matchAll(/<(th|td|h2|strong)><code>([^<]*)<\/code><\/\1>/g)];
    expect(slots.map((slot) => slot[1])).toEqual(['th', 'td', 'h2', 'strong']);
    for (const slot of slots) expect(decode(slot[2] ?? '')).toBe(text);
  });

  it.each([
    ['one long line ending in a break', (size: number) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size: number) => '  \r\n'.repeat(size / 4)],
    ['one backtick run', (size: number) => `${'`'.repeat(size)}\n`],
    ['alternating backticks and pipes', (size: number) => `${'`|'.repeat(size / 2)}\n`],
    ['inner whitespace with a trailing space', (size: number) => `a${' '.repeat(size)}a `],
  ] as const)('bounds thread CPU growth of the code-span path for %s', (shape, makeText) => {
    // Kept below Bun's ~80k regex tier switch; the digit run below carries the 64× span.
    const sizes = [5_000, 10_000, 20_000, 40_000, 80_000];
    const samples = timeBothSlots(sizes, makeText);
    // Quadratic growth over this 16× span is 256×; linear is 16×.
    expect((samples.at(-1) ?? 0) / Math.max(samples[0] ?? 0, 1)).toBeLessThan(64);
    console.info(JSON.stringify({ shape, sizes, threadCpuMicroseconds: samples }));
  });

  it('bounds thread CPU growth of the code-span path for a long digit run with a break', () => {
    const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    const samples = timeBothSlots(sizes, (size) => `${'1'.repeat(size)}\n`);
    expect((samples.at(-1) ?? 0) / Math.max(samples[0] ?? 0, 1)).toBeLessThan(256);
    console.info(JSON.stringify({ shape: 'long digits', sizes, threadCpuMicroseconds: samples }));
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

  it('escapes pipes in plain table cells', () => {
    expect(cell('A|B C')).toBe('A\\|B C');
  });

  it('escapes backslashes in table cells, so an escaped pipe in the text stays inside one cell', () => {
    expect(cell('A\\|B')).toBe('A\\\\\\|B');
    expect(cell('C:\\path')).toBe('C:\\\\path');
  });

  it.each([
    [0.9569929993881674, '0.9569929993881674'],
    [18744254.463, '18,744,254.463'],
    [1523.6925791035985, '1,523.6925791035985'],
    [29.359363004489346, '29.359363004489346'],
    [77.5, '77.5'],
    [22.972972972972972, '22.972972972972972'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1e-7, '0.0000001'],
    [123456789012345680000, '123,456,789,012,345,680,000'],
    [-1234.5, '-1,234.5'],
    [-0, '0'],
    [0, '0'],
    [4091315000, '4,091,315,000'],
  ])('renders %s with en-US grouping and every digit JSON carries', (value, expected) => {
    const rendered = num(value);
    expect(rendered).toBe(expected);
    expect(Number(rendered.replaceAll(',', ''))).toBe(value === 0 ? 0 : value);
  });

  it('renders an absent number as an em dash', () => {
    expect(num(null)).toBe('—');
    expect(num(undefined)).toBe('—');
  });

  it.each([
    [0.9569929993881674, 'percent', '0.9569929993881674%'],
    [0, 'percent', '0%'],
    [77.5, 'count', '77.5'],
    [226846.4, 'count', '226,846.4'],
    [51234.567, 'usd_thousands', '51,234.567'],
    [1.7125, undefined, '1.7125'],
    [null, 'percent', '—'],
    [null, 'count', '—'],
  ] as const)('renders metric value %j in unit %s as %s', (value, unit, expected) => {
    expect(metricValue(value, unit)).toBe(expected);
  });
});

/**
 * Thread CPU microseconds for 20 `inline()` and `cell()` renders at each size, checking
 * the absolute budget before the next larger input.
 */
function timeBothSlots(sizes: readonly number[], makeText: (size: number) => string): number[] {
  const samples: number[] = [];
  for (const size of sizes) {
    const text = makeText(size);
    inline(text);
    cell(text);
    const start = process.threadCpuUsage();
    for (let iteration = 0; iteration < 20; iteration++) {
      inline(text);
      cell(text);
    }
    const cpu = process.threadCpuUsage(start);
    const microseconds = cpu.user + cpu.system;
    samples.push(microseconds);
    expect(microseconds).toBeLessThan(1_000_000);
  }
  return samples;
}
