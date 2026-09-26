/**
 * @fileoverview Tests for fdic_compare_peers over a faked FDIC transport: the
 * latest-quarter default, the institution's own Call Report row, the peer query
 * each band/state/explicit-list input builds, peer paging past 10,000 rows,
 * statistics with zero-means-unreported ratios excluded, peer-group notices,
 * both output surfaces, and every declared error reason.
 * @module tests/tools/compare-peers.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comparePeersTool } from '@/mcp-server/tools/definitions/compare-peers.tool.js';
import { disposeFdicService } from '@/services/fdic/fdic-service.js';
import { BRIDGE_BANK, FAILED_BANK, HARBOR_BANK } from '../fixtures/fdic-records.js';
import {
  envelope,
  FakeFdic,
  type FakeRequest,
  INDEX,
  installFakeService,
} from '../helpers/fake-fdic.js';
import { contractRecovery, structured, textOf, toolError } from '../helpers/tool-results.js';

type Output = z.infer<typeof comparePeersTool.output> & { notice?: string };
type Input = z.input<typeof comparePeersTool.input>;
type P = Readonly<Record<string, string>>;

const tool = comparePeersTool;
const CERT = 57701;
const METRICS = ['total_assets', 'roa', 'cet1_ratio'] as const;

const isLatest = (p: P) => p.fields === 'REPDTE';
const isOwnRow = (p: P) => p.limit === '1' && (p.fields ?? '').startsWith('NAME,STALP,ASSET');
const isPeers = (p: P) => p.limit === '10000';

/** The institution's own row as filed on the Call Report: uppercase abbreviated name, CET1 unreported. */
const OWN_ROW = {
  ASSET: 2456123,
  ROAQ: 1.25,
  STALP: 'WA',
  NAME: 'EVERGREEN HARBOR BK',
  IDT1CER: 0,
  ID: '57701_20260630',
};

/** Peer rows for 2026-06-30: the institution itself, a leverage-ratio filer (CET1 0), and one with no ROAQ. */
const PEER_ROWS = [
  { ASSET: 2456123, ROAQ: 1.25, IDT1CER: 0, CERT: 57701, ID: '57701_20260630' },
  { ASSET: 1500000, ROAQ: 2, IDT1CER: 12, CERT: 1001, ID: '1001_20260630' },
  { ASSET: 3000000, ROAQ: 0.5, IDT1CER: 0, CERT: 1002, ID: '1002_20260630' },
  { ASSET: 5000000, ROAQ: 1.5, IDT1CER: 14, CERT: 1003, ID: '1003_20260630' },
  { ASSET: 9000000, ROAQ: 1, IDT1CER: 11, CERT: 1004, ID: '1004_20260630' },
  { ASSET: 1200000, IDT1CER: 13, CERT: 1005, ID: '1005_20260630' },
];

let fake: FakeFdic;

beforeEach(() => {
  fake = new FakeFdic();
  installFakeService(fake);
});

afterEach(() => {
  disposeFdicService();
});

function withLatest(repdte = '20260630') {
  fake.on(
    'financials',
    isLatest,
    envelope('financials', [{ REPDTE: repdte, ID: `628_${repdte}` }], { total: 1_680_000 }),
  );
}

function withOwnRow(row: Record<string, unknown> | null = OWN_ROW) {
  fake.on('financials', isOwnRow, envelope('financials', row ? [row] : []));
}

function withPeers(rows: Record<string, unknown>[] = PEER_ROWS) {
  fake.on('financials', isPeers, envelope('financials', rows));
}

function withProfile(record: Record<string, unknown> | null) {
  fake.on('institutions', () => true, envelope('institutions', record ? [record] : []));
}

function requestsWhere(predicate: (p: P) => boolean): FakeRequest[] {
  return fake.requests.filter((r) => predicate(r.params));
}

function peerParams(): P {
  const request = requestsWhere(isPeers)[0];
  if (!request) throw new Error('No peer request was sent');
  return request.params;
}

async function run(input: Input) {
  const result = await runToolContract(tool, input);
  return { result, text: textOf(result) };
}

async function handle(input: Input) {
  const ctx = createMockContext({ errors: tool.errors });
  const output = await tool.handler(tool.input.parse(input), ctx);
  return { output, enrichment: getEnrichment(ctx) };
}

describe('comparison', () => {
  it('compares against the same asset band nationwide for the latest published quarter', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output, enrichment } = await handle({ cert: CERT, metrics: [...METRICS] });

    const own = requestsWhere(isOwnRow)[0]?.params;
    expect(own?.filters).toBe('CERT:57701 AND REPDTE:"20260630"');
    // total_assets maps to ASSET, which the own-row lookup already requests.
    expect(own?.fields).toBe('NAME,STALP,ASSET,ROAQ,IDT1CER');
    expect(peerParams()).toEqual({
      filters: 'REPDTE:"20260630" AND ASSET:[1000000 TO 10000000}',
      fields: 'CERT,ASSET,ROAQ,IDT1CER',
      sort_by: 'CERT',
      sort_order: 'ASC',
      limit: '10000',
      offset: '0',
    });

    expect(output.institution).toEqual({
      cert: 57701,
      name: 'EVERGREEN HARBOR BK',
      state: 'WA',
      total_assets: 2456123,
      asset_band: '1b_10b',
    });
    expect(output.report_date).toBe('2026-06-30');
    expect(output.report_date_defaulted).toBe(true);
    expect(output.peer_group).toEqual({
      asset_band: '1b_10b',
      explicit_certs: false,
      peer_count: 5,
      definition:
        'Institutions with total assets of $1–10 billion that filed a Call Report for 2026-06-30, nationwide, excluding CERT 57701 itself.',
    });
    expect(output.data_as_of).toBe(INDEX.financials.createTimestamp);
    expect(enrichment).toEqual({
      notice: 'Fewer than five peers reported roa, cet1_ratio; their quartiles are not meaningful.',
    });
  });

  it('excludes the institution itself, peers without a value, and unreported zero ratios', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output } = await handle({ cert: CERT, metrics: [...METRICS] });
    const [assets, roa, cet1] = output.comparisons;

    expect(roa).toEqual({
      metric: 'roa',
      field: 'ROAQ',
      unit: 'percent',
      basis: 'quarter_annualized',
      value: 1.25,
      peer_count_with_value: 4,
      peer_median: 1.25,
      peer_p25: 0.875,
      peer_p75: 1.625,
      peer_min: 0.5,
      peer_max: 2,
      percentile: 50,
      rank: 3,
      rank_of: 5,
    });
    expect(cet1).toMatchObject({
      value: null,
      peer_count_with_value: 4,
      peer_median: 12.5,
      peer_min: 11,
      percentile: null,
      rank: null,
      rank_of: null,
    });
    expect(assets).toMatchObject({
      value: 2456123,
      peer_count_with_value: 5,
      peer_median: 3_000_000,
      percentile: 40,
      rank: 4,
      rank_of: 6,
    });
  });

  it('uses the given quarter without a latest-quarter lookup', async () => {
    withOwnRow({ ...OWN_ROW, ID: '57701_20260331' });
    withPeers();
    const { output } = await handle({ cert: CERT, report_date: '2026Q1', metrics: ['roa'] });
    expect(requestsWhere(isLatest)).toHaveLength(0);
    expect(requestsWhere(isOwnRow)[0]?.params.filters).toBe('CERT:57701 AND REPDTE:"20260331"');
    expect(peerParams().filters).toMatch(/^REPDTE:"20260331"/);
    expect(output).toMatchObject({ report_date: '2026-03-31', report_date_defaulted: false });
  });

  it('computes the default health set when metrics are omitted', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output } = await handle({ cert: CERT });
    expect(output.comparisons.map((c) => c.metric)).toEqual([
      'total_assets',
      'total_deposits',
      'uninsured_deposits',
      'equity_capital',
      'net_income',
      'roa',
      'roe',
      'net_interest_margin',
      'efficiency_ratio',
      'noncurrent_loan_rate',
      'net_charge_off_rate',
      'loans_to_deposits',
      'leverage_ratio',
      'cet1_ratio',
      'total_risk_based_capital_ratio',
    ]);
  });
});

describe('peer group', () => {
  it.each<[Input['peer_asset_band'], string, string]>([
    ['any', 'REPDTE:"20260630"', 'any'],
    ['under_100m', 'REPDTE:"20260630" AND ASSET:[* TO 100000}', 'under_100m'],
    ['100m_1b', 'REPDTE:"20260630" AND ASSET:[100000 TO 1000000}', '100m_1b'],
    ['over_250b', 'REPDTE:"20260630" AND ASSET:[250000000 TO *]', 'over_250b'],
  ])('sends band %s as %s', async (band, filters, resolved) => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output } = await handle({ cert: CERT, metrics: ['roa'], peer_asset_band: band });
    expect(peerParams().filters).toBe(filters);
    expect(output.peer_group.asset_band).toBe(resolved);
    expect(output.institution.asset_band).toBe('1b_10b');
  });

  it('describes an any-size group', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output } = await handle({ cert: CERT, metrics: ['roa'], peer_asset_band: 'any' });
    expect(output.peer_group.definition).toBe(
      'Institutions of any size that filed a Call Report for 2026-06-30, nationwide, excluding CERT 57701 itself.',
    );
  });

  it.each([
    ['same', 'WA'],
    ['SAME', 'WA'],
    ['Oregon', 'OR'],
    ['id', 'ID'],
  ])('narrows peers to state %j as %s', async (peerState, code) => {
    withLatest();
    withOwnRow();
    withPeers();
    const { output } = await handle({ cert: CERT, metrics: ['roa'], peer_state: peerState });
    expect(peerParams().filters).toBe(
      `REPDTE:"20260630" AND ASSET:[1000000 TO 10000000} AND STALP:"${code}"`,
    );
    expect(output.peer_group.state).toBe(code);
    expect(output.peer_group.definition).toContain(`headquartered in ${code}`);
  });

  it('compares against an explicit peer list and names peers that did not file', async () => {
    withLatest();
    withOwnRow();
    withPeers(PEER_ROWS.slice(0, 3));
    const { output, enrichment } = await handle({
      cert: CERT,
      metrics: ['roa'],
      peer_certs: [1001, 1002, 57701, 9999, 1001],
    });
    expect(peerParams().filters).toBe('CERT:(1001 OR 1002 OR 57701 OR 9999) AND REPDTE:"20260630"');
    expect(output.peer_group).toEqual({
      asset_band: 'any',
      explicit_certs: true,
      peer_count: 2,
      definition:
        'The 2 institutions named in peer_certs that filed a Call Report for 2026-06-30; peer_asset_band and peer_state do not apply.',
    });
    expect(output.peer_certs_missing).toEqual([9999]);
    expect(enrichment.notice).toBe(
      'Fewer than five peers reported roa; its quartiles are not meaningful.',
    );
  });

  it('reports an empty band group with a notice and null statistics', async () => {
    withLatest();
    withOwnRow();
    withPeers(PEER_ROWS.slice(0, 1));
    const { output, enrichment } = await handle({
      cert: CERT,
      metrics: ['roa'],
      peer_state: 'same',
    });
    expect(output.peer_group.peer_count).toBe(0);
    expect(output.comparisons[0]).toMatchObject({
      peer_count_with_value: 0,
      peer_median: null,
      percentile: null,
      rank: 1,
      rank_of: 1,
    });
    expect(enrichment).toEqual({
      notice:
        'No institutions matched the peer group; set peer_asset_band to any or drop peer_state.',
    });
  });

  it('reports an explicit list with no filers', async () => {
    withLatest();
    withOwnRow();
    withPeers([]);
    const { output, enrichment } = await handle({
      cert: CERT,
      metrics: ['roa'],
      peer_certs: [4, 5],
    });
    expect(output.peer_certs_missing).toEqual([4, 5]);
    expect(enrichment.notice).toBe(
      'None of the peer_certs filed a Call Report for 2026-06-30; check them with fdic_search_institutions.',
    );
  });

  it('pages peers by offset past 10,000 rows and computes over every page', async () => {
    const page1 = Array.from({ length: 10_000 }, (_, i) => ({
      ROAQ: (i % 200) / 100,
      CERT: 100_000 + i,
      ID: `${100_000 + i}_20260630`,
    }));
    const page2 = [
      { ROAQ: 5, CERT: 200_001, ID: '200001_20260630' },
      { ROAQ: 1.25, CERT: 57701, ID: '57701_20260630' },
      { ROAQ: -3, CERT: 200_003, ID: '200003_20260630' },
    ];
    withLatest();
    withOwnRow();
    fake.on('financials', isPeers, (request: FakeRequest) =>
      envelope('financials', request.params.offset === '0' ? page1 : page2, { total: 10_003 }),
    );
    const { output } = await handle({ cert: CERT, metrics: ['roa'], peer_asset_band: 'any' });

    expect(requestsWhere(isPeers).map((r) => r.params.offset)).toEqual(['0', '10000']);
    expect(output.peer_group.peer_count).toBe(10_002);
    expect(output.comparisons[0]).toMatchObject({
      peer_count_with_value: 10_002,
      peer_max: 5,
      peer_min: -3,
    });
  });

  it('treats blank report_date, band, and state and an empty peer list as unset', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { result } = await run({
      cert: CERT,
      metrics: ['roa'],
      report_date: '',
      peer_asset_band: ' ',
      peer_state: '',
      peer_certs: [],
    } as unknown as Input);
    const output = structured<Output>(result);
    expect(output).toMatchObject({ report_date_defaulted: true, report_date: '2026-06-30' });
    expect(output.peer_group).toMatchObject({ asset_band: '1b_10b', explicit_certs: false });
    expect(output.peer_group).not.toHaveProperty('state');
  });
});

describe('both surfaces through the production contract', () => {
  it('validates the empty peer group with its notice on structuredContent and content[]', async () => {
    withLatest();
    withOwnRow();
    withPeers([]);
    const { result, text } = await run({ cert: CERT, metrics: ['roa'] });
    const output = structured<Output>(result);
    expect(output.peer_group.peer_count).toBe(0);
    expect(output.notice).toBe(
      'No institutions matched the peer group; set peer_asset_band to any or drop peer_state.',
    );
    expect(text).toContain('0 peers · band 1b_10b · explicit peer_certs: no');
    expect(text).toContain('> No institutions matched the peer group');
  });

  it('validates a thin peer group with its notice on both surfaces and renders the full table', async () => {
    withLatest();
    withOwnRow();
    withPeers();
    const { result, text } = await run({ cert: CERT, metrics: [...METRICS] });
    expect(structured<Output>(result).notice).toBe(
      'Fewer than five peers reported roa, cet1_ratio; their quartiles are not meaningful.',
    );
    expect(text).toContain('## EVERGREEN HARBOR BK (CERT 57701) vs. peers — 2026-06-30');
    expect(text).toContain('WA · total assets 2,456,123 (USD thousands) · size band 1b_10b');
    expect(text).toContain(
      `Report date 2026-06-30 (latest published quarter; report_date defaulted). Data as of ${INDEX.financials.createTimestamp}.`,
    );
    expect(text).toContain('**Peer group:** Institutions with total assets of $1–10 billion');
    expect(text).toContain('5 peers · band 1b_10b · explicit peer_certs: no');
    expect(text).toContain(
      '| total_assets | ASSET | usd_thousands | point_in_time | 2,456,123 | 3,000,000 | 1,500,000 | 5,000,000 | 1,200,000 | 9,000,000 | 40 | 4 of 6 | 5 |',
    );
    expect(text).toContain(
      '| roa | ROAQ | percent | quarter_annualized | 1.25% | 1.25% | 0.88% | 1.63% | 0.5% | 2% | 50 | 3 of 5 | 4 |',
    );
    expect(text).toContain(
      '| cet1_ratio | IDT1CER | percent | point_in_time | — | 12.5% | 11.75% | 13.25% | 11% | 14% | — | — | 4 |',
    );
    expect(text).toContain('> Fewer than five peers reported roa, cet1_ratio');
  });

  it('renders the state, explicit list, and missing peers', async () => {
    withLatest();
    withOwnRow();
    withPeers(PEER_ROWS.slice(0, 2));
    const { text } = await run({ cert: CERT, metrics: ['roa'], peer_certs: [1001, 8888] });
    expect(text).toContain('1 peers · band any · explicit peer_certs: yes');
    expect(text).toContain('Peer CERTs without a report for the quarter: 8888.');

    const stateRun = await run({
      cert: CERT,
      metrics: ['roa'],
      peer_state: 'same',
      report_date: '2026Q2',
    });
    expect(stateRun.text).toContain('· state WA');
    expect(stateRun.text).not.toContain('report_date defaulted');
  });
});

describe('errors', () => {
  it('fails cert_not_found when no institution record carries the CERT', async () => {
    withLatest();
    withOwnRow(null);
    withProfile(null);
    const { result, text } = await run({ cert: 999999, report_date: '2026Q2' });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'cert_not_found',
      recovery: {
        hint: 'Look up the CERT with fdic_search_institutions by name, then call this tool again with that CERT.',
      },
    });
    expect(text).toContain('reason cert_not_found');
    expect(requestsWhere(isPeers)).toHaveLength(0);
  });

  it('fails report_date_not_available past the latest published quarter, naming it', async () => {
    withLatest('20260630');
    withOwnRow(null);
    withProfile(HARBOR_BANK);
    const { result, text } = await run({ cert: CERT, report_date: '2026-09-30' });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('report_date_not_available');
    expect(error.data?.recovery?.hint).toBe(
      'Omit report_date to use the latest published quarter (2026-06-30), or pass an earlier quarter-end date.',
    );
    expect(text).toContain('the latest published quarter is 2026-06-30');
  });

  it('fails no_report_for_period for an explicit quarter, pointing at the last report', async () => {
    withLatest('20260630');
    withOwnRow(null);
    withProfile(FAILED_BANK);
    const { result } = await run({ cert: 24900, report_date: '2023Q2' });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      'CERT 24900 filed no Call Report for 2023-06-30; its last report is 2022-12-31.',
    );
    expect(error.data).toMatchObject({
      reason: 'no_report_for_period',
      recovery: {
        hint: 'Pass report_date 2022-12-31 (its last report), or call fdic_get_institution_financials for CERT 24900 to see its reported quarters.',
      },
    });
  });

  it('fails no_report_for_period on the defaulted quarter without a second latest-quarter lookup', async () => {
    // Uncached, so a second lookup would show up as a second request.
    installFakeService(fake, { cacheTtlSeconds: 0 });
    withLatest('20260630');
    withOwnRow(null);
    withProfile(BRIDGE_BANK);
    const { result } = await run({ cert: 59400 });
    const error = toolError(result);
    expect(error.data).toMatchObject({
      reason: 'no_report_for_period',
      recovery: {
        hint: 'Call fdic_get_institution_financials for CERT 59400 to see its reported quarters, then pass one of those as report_date.',
      },
    });
    expect(requestsWhere(isLatest)).toHaveLength(1);
  });

  it('fails invalid_state for an unknown peer_state before any request', async () => {
    const { result } = await run({ cert: CERT, peer_state: 'Pacifica' });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_state',
      recovery: {
        hint: "Pass a two-letter postal code such as WA, a full state name, or same for the institution's own state.",
      },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it.each<[string, Input, string]>([
    ['a band', { cert: CERT, peer_certs: [1001], peer_asset_band: 'over_250b' }, 'peer_asset_band'],
    [
      'the default band named explicitly',
      { cert: CERT, peer_certs: [1001], peer_asset_band: 'same' },
      'peer_asset_band',
    ],
    ['a state', { cert: CERT, peer_certs: [1001], peer_state: 'Pacifica' }, 'peer_state'],
    [
      'a band and a state',
      { cert: CERT, peer_certs: [1001], peer_asset_band: 'any', peer_state: 'same' },
      'peer_asset_band and peer_state',
    ],
  ])(
    'fails conflicting_peer_filters for peer_certs with %s, before any request',
    async (_label, input, named) => {
      const { result, text } = await run(input);
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(`peer_certs cannot be combined with ${named}.`);
      expect(error.data).toMatchObject({
        reason: 'conflicting_peer_filters',
        recovery: { hint: contractRecovery(tool, 'conflicting_peer_filters') },
      });
      expect(text).toContain('reason conflicting_peer_filters');
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each<[string, Input, string]>([
    ['total assets for the default same band', { cert: CERT, metrics: ['roa'] }, 'ASSET'],
    [
      'a state for peer_state same',
      { cert: CERT, metrics: ['roa'], peer_asset_band: 'any', peer_state: 'same' },
      'STALP',
    ],
  ])(
    'fails own_filing_incomplete when the filing lacks %s, before the peer request',
    async (_label, input, field) => {
      withLatest();
      const incomplete: Record<string, unknown> = { ...OWN_ROW };
      delete incomplete[field];
      withOwnRow(incomplete);
      const { result, text } = await run(input);
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({
        reason: 'own_filing_incomplete',
        recovery: { hint: contractRecovery(tool, 'own_filing_incomplete') },
      });
      expect(error.data).not.toHaveProperty('retryable', true);
      expect(text).toContain('reason own_filing_incomplete');
      expect(requestsWhere(isPeers)).toHaveLength(0);
    },
  );

  it.each<[string, Partial<Input>]>([
    ['peer_asset_band any', { peer_asset_band: 'any' }],
    ['a named band', { peer_asset_band: '1b_10b' }],
    ['peer_certs', { peer_certs: [1001, 1002] }],
  ])(
    'still compares a filing without total assets under %s, saying so on both surfaces',
    async (_label, peers) => {
      withLatest();
      const withoutAssets: Record<string, unknown> = { ...OWN_ROW };
      delete withoutAssets.ASSET;
      withOwnRow(withoutAssets);
      withPeers();
      const { result, text } = await run({
        cert: CERT,
        metrics: ['total_assets', 'roa'],
        ...peers,
      });
      const output = structured<Output>(result);
      expect(output.institution).toEqual({ cert: CERT, name: 'EVERGREEN HARBOR BK', state: 'WA' });
      expect(output.comparisons[0]).toMatchObject({ metric: 'total_assets', value: null });
      expect(output.comparisons[1]).toMatchObject({ metric: 'roa', value: 1.25 });
      expect(text).toContain('WA · total assets not reported for the quarter');
      expect(text).not.toContain('size band');
    },
  );

  it('fails cert_not_found for an explicit quarter even when the latest-quarter lookup is throttled', async () => {
    withOwnRow(null);
    withProfile(null);
    fake.on('financials', isLatest, () => {
      throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
    });
    const { result } = await run({ cert: 999999, report_date: '2026Q3' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'cert_not_found' },
    });
  });

  it('falls back to no_report_for_period when the latest-quarter lookup is throttled', async () => {
    withOwnRow(null);
    withProfile(HARBOR_BANK);
    fake.on('financials', isLatest, () => {
      throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
    });
    const { result } = await run({ cert: CERT, report_date: '2026Q3' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'CERT 57701 filed no Call Report for 2026-09-30; its last report is 2026-06-30.',
      data: { reason: 'no_report_for_period' },
    });
  });

  it('reports a call cancelled during the miss classification as cancelled', async () => {
    const controller = new AbortController();
    withOwnRow(null);
    withProfile(HARBOR_BANK);
    fake.on('financials', isLatest, () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const result = await runToolContract(
      tool,
      { cert: CERT, report_date: '2026Q3' },
      { context: { signal: controller.signal } },
    );
    expect(toolError(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('reports a saturated request queue as pacer_shed', async () => {
    const pacer = createPacer({ name: 'fdic-shed', limits: [{ requests: 1, perMs: 60_000 }] });
    installFakeService(fake, { pacer });
    withLatest();
    withOwnRow();
    withPeers();
    const { result } = await run({ cert: CERT, metrics: ['roa'] });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryable: true },
    });
  });

  it('reports an exhausted FDIC 429 as upstream_rate_limited', async () => {
    withLatest();
    withOwnRow();
    fake.on('financials', isPeers, () => {
      throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
    });
    const { result } = await run({ cert: CERT, metrics: ['roa'] });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited', retryAfter: 30 },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a report date that is not a quarter end', { report_date: '2026-06-15' }],
    ['quarter 0', { report_date: '2026Q0' }],
    ['a zero cert', { cert: 0 }],
    ['a zero peer CERT', { peer_certs: [0] }],
    ['more than 200 peer CERTs', { peer_certs: Array.from({ length: 201 }, (_, i) => i + 1) }],
    ['an unknown band', { peer_asset_band: 'huge' }],
    ['more than 20 metrics', { metrics: Array.from({ length: 21 }, () => 'roa') }],
  ])('rejects %s at the schema', async (_label, input) => {
    const { result } = await run({ cert: CERT, ...input } as Input);
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(fake.requests).toHaveLength(0);
  });
});
