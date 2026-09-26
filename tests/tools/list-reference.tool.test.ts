/**
 * @fileoverview Tests for fdic_list_reference: every topic served from the same
 * static tables the data tools read, on both the structuredContent and content[]
 * surfaces, plus schema rejection of an unknown topic.
 * @module tests/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import {
  METRIC_CATALOG,
  METRIC_NAMES,
  ZERO_UNREPORTED_NOTE,
} from '@/services/fdic/metric-catalog.js';
import { structured, textOf, toolError } from '../helpers/tool-results.js';

type Entry = {
  basis?: string;
  cadence?: string;
  code: string;
  field?: string;
  in_default_set?: boolean;
  label: string;
  lag?: string;
  max_assets?: number;
  min_assets?: number;
  note?: string;
  resolution?: string;
  starts?: string;
  unit?: string;
};
type Output = { entries: Entry[]; topic: string };

type Topic = Parameters<typeof listReferenceTool.handler>[0]['topic'];

async function list(topic: Topic) {
  const result = await runToolContract(listReferenceTool, { topic });
  return { result, output: structured<Output>(result), text: textOf(result) };
}

describe('fdic_list_reference', () => {
  it('lists every catalog metric with its field, unit, basis, and default-set flag', async () => {
    const { output, text } = await list('metrics');
    expect(output.topic).toBe('metrics');
    expect(output.entries.map((e) => e.code)).toEqual([...METRIC_NAMES]);
    for (const entry of output.entries) {
      const def = METRIC_CATALOG[entry.code as keyof typeof METRIC_CATALOG];
      expect(entry).toMatchObject({
        field: def.field,
        unit: def.unit,
        basis: def.basis,
        label: def.label,
      });
      expect(text).toContain(`**${entry.code}**`);
      expect(text).toContain(`field ${def.field}`);
    }
    expect(output.entries.filter((e) => e.in_default_set)).toHaveLength(15);
    expect(output.entries.find((e) => e.code === 'cet1_ratio')).toMatchObject({
      field: 'IDT1CER',
      in_default_set: true,
      note: ZERO_UNREPORTED_NOTE,
    });
    expect(output.entries.find((e) => e.code === 'net_income_ytd')).toMatchObject({
      field: 'NETINC',
      basis: 'year_to_date',
      in_default_set: false,
    });
    expect(text).toContain('## FDIC reference — metrics (49 entries)');
    expect(text).toContain('in default set: yes');
    expect(text).toContain(`note: ${ZERO_UNREPORTED_NOTE}`);
  });

  it('lists the eight bank charter classes', async () => {
    const { output, text } = await list('bank_classes');
    const classes = ['N', 'NM', 'SM', 'SB', 'SI', 'SL', 'OI', 'NC'];
    expect(output.entries.map((e) => e.code)).toEqual(classes);
    expect(text).toContain('**OI** — Insured U.S. branch of a foreign bank');
  });

  it('lists failure methods with the resolution type each occurs on, when only one', async () => {
    const { output, text } = await list('failure_methods');
    expect(output.entries).toHaveLength(11);
    const byCode = new Map(output.entries.map((e) => [e.code, e]));
    expect(byCode.get('PA')?.resolution).toBe('FAILURE');
    expect(byCode.get('A/A')?.resolution).toBe('ASSISTANCE');
    expect(byCode.get('OBAM')?.resolution).toBe('ASSISTANCE');
    expect(byCode.get('REP')).not.toHaveProperty('resolution');
    expect(text).toContain('**A/A** — Assistance transaction — occurs on ASSISTANCE only');
  });

  it('lists the insurance funds', async () => {
    const { output } = await list('insurance_funds');
    const funds = ['DIF', 'BIF', 'SAIF', 'RTC', 'FSLIC', 'FDIC'];
    expect(output.entries.map((e) => e.code)).toEqual(funds);
  });

  it('lists peer asset bands with same and any first, bounds in USD thousands', async () => {
    const { output, text } = await list('peer_asset_bands');
    expect(output.entries.map((e) => e.code)).toEqual([
      'same',
      'any',
      'under_100m',
      '100m_1b',
      '1b_10b',
      '10b_250b',
      'over_250b',
    ]);
    const byCode = new Map(output.entries.map((e) => [e.code, e]));
    expect(byCode.get('same')).not.toHaveProperty('min_assets');
    expect(byCode.get('under_100m')).toMatchObject({ max_assets: 100_000 });
    expect(byCode.get('under_100m')).not.toHaveProperty('min_assets');
    expect(byCode.get('1b_10b')).toMatchObject({ min_assets: 1_000_000, max_assets: 10_000_000 });
    expect(byCode.get('over_250b')).toMatchObject({ min_assets: 250_000_000 });
    expect(byCode.get('over_250b')).not.toHaveProperty('max_assets');
    expect(text).toContain('min_assets ≥ 1,000,000 · max_assets < 10,000,000');
    expect(text).toContain('Band bounds are total assets in thousands of US dollars.');
  });

  it('lists dataset coverage with start, cadence, and lag where one applies', async () => {
    const { output, text } = await list('coverage');
    const byCode = new Map(output.entries.map((e) => [e.code, e]));
    expect(byCode.get('financials')).toMatchObject({
      starts: '1984Q1 (1984-03-31)',
      lag: 'about seven weeks after quarter end',
    });
    expect(byCode.get('summary_of_deposits')?.cadence).toBe('annual, as of June 30');
    expect(byCode.get('failures')).not.toHaveProperty('lag');
    expect(text).toContain('starts 1934');
  });

  it('declares no enrichment and adds no trailer to content[]', async () => {
    const { result } = await list('insurance_funds');
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['topic', 'entries']);
    expect(result.content).toHaveLength(1);
  });

  it.each([
    ['an unknown topic', { topic: 'states' }],
    ['an uppercase topic', { topic: 'METRICS' }],
    ['a missing topic', {}],
  ])('rejects %s at the schema', async (_label, input) => {
    const result = await runToolContract(listReferenceTool, input as never);
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});
