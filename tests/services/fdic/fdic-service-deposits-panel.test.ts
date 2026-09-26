/**
 * @fileoverview Tests for the Wave 2 FdicService methods over a faked FDIC
 * transport: the Summary of Deposits lookups (latest survey year, branch pages
 * past 10,000 rows, market and state aggregations, CERT→name lookups and the
 * paged directory) and the financial panel (quarter planning under the row cap,
 * the aggregation preflight, and per-quarter CERT-ordered paging).
 * @module tests/services/fdic/fdic-service-deposits-panel.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { getDepositsTool } from '@/mcp-server/tools/definitions/get-deposits.tool.js';
import { queryFinancialsTool } from '@/mcp-server/tools/definitions/query-financials.tool.js';
import { callBudget, FdicService, planPanelQuarters } from '@/services/fdic/fdic-service.js';
import type { PanelFilters } from '@/services/fdic/types.js';
import type { StateCode } from '@/services/fdic/us-states.js';
import {
  MAIN_OFFICE_BRANCH,
  panelRow,
  RURAL_BRANCH,
  sodBranch,
} from '../../fixtures/fdic-records.js';
import { aggEnvelope, envelope, FakeFdic, type FakeRequest } from '../../helpers/fake-fdic.js';

const BRANCH_FIELDS =
  'CERT,NAMEFULL,BRNUM,UNINUMBR,NAMEBR,BKMO,ADDRESBR,CITYBR,CNTYNAMB,STALPBR,ZIPBR,MSABR,MSANAMB,DEPSUMBR,SIMS_ESTABLISHED_DATE,SIMS_LATITUDE,SIMS_LONGITUDE';
/** A state code as the handlers pass it, already normalized. */
const WA = 'WA' as StateCode;

function serviceOver(fake: FakeFdic) {
  return new FdicService({
    getJson: fake.getJson,
    pacer: createPacer({ name: 'fdic-test' }),
    cacheTtlSeconds: 3600,
  });
}

const sodCtx = () => createMockContext({ errors: getDepositsTool.errors });
const panelCtx = () => createMockContext({ errors: queryFinancialsTool.errors });

/** Serves `rows` a page at a time by `offset`/`limit`, reporting `total` (default: all rows). */
function paged(
  rows: Record<string, unknown>[],
  total = rows.length,
  endpoint: 'sod' | 'institutions' = 'sod',
) {
  return (request: FakeRequest) => {
    const offset = Number(request.params.offset ?? 0);
    const limit = Number(request.params.limit);
    return envelope(endpoint, rows.slice(offset, offset + limit), { total });
  };
}

describe('planPanelQuarters', () => {
  const q = (reportDate: string, rows: number) => ({ reportDate, rows });

  it.each([
    {
      label: 'every quarter when they fit',
      quarters: [q('2026-06-30', 100), q('2026-03-31', 200)],
      maxRows: 1000,
      plan: [q('2026-06-30', 100), q('2026-03-31', 200)],
    },
    {
      label: 'quarters that fill the cap exactly',
      quarters: [q('2026-06-30', 500), q('2026-03-31', 500)],
      maxRows: 1000,
      plan: [q('2026-06-30', 500), q('2026-03-31', 500)],
    },
    {
      label: 'whole quarters newest first, dropping the oldest that would overflow',
      quarters: [q('2026-06-30', 20_000), q('2026-03-31', 20_000), q('2025-12-31', 20_000)],
      maxRows: 50_000,
      plan: [q('2026-06-30', 20_000), q('2026-03-31', 20_000)],
    },
    {
      label: 'a contiguous run, never skipping to a smaller older quarter',
      quarters: [q('2026-06-30', 30_000), q('2026-03-31', 30_000), q('2025-12-31', 5000)],
      maxRows: 50_000,
      plan: [q('2026-06-30', 30_000)],
    },
    {
      label: 'the newest quarter capped when it alone exceeds the cap',
      quarters: [q('2026-06-30', 60_000), q('2026-03-31', 100)],
      maxRows: 50_000,
      plan: [q('2026-06-30', 50_000)],
    },
    { label: 'nothing for no quarters', quarters: [], maxRows: 50_000, plan: [] },
  ])('plans $label', ({ quarters, maxRows, plan }) => {
    expect(planPanelQuarters(quarters, maxRows)).toEqual(plan);
  });
});

describe('latestSodYear', () => {
  it('reads the newest survey year once and serves repeats from the cache', async () => {
    const fake = new FakeFdic().on(
      'sod',
      (p) => p.fields === 'YEAR',
      envelope('sod', [{ YEAR: '2026', ID: '2026_1_1' }], { total: 2_900_000 }),
    );
    const service = serviceOver(fake);
    const first = await service.latestSodYear(sodCtx(), callBudget());
    const second = await service.latestSodYear(sodCtx(), callBudget());
    expect(first).toEqual({ year: 2026, dataAsOf: '2026-09-18T10:22:35Z' });
    expect(second).toEqual(first);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.params).toEqual({
      fields: 'YEAR',
      sort_by: 'YEAR',
      sort_order: 'DESC',
      limit: '1',
    });
  });

  it('fails as ServiceUnavailable when FDIC returns no survey year', async () => {
    const fake = new FakeFdic().on('sod', () => true, envelope('sod', []));
    await expect(serviceOver(fake).latestSodYear(sodCtx(), callBudget())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('getBranches', () => {
  it('filters on CERT, every geography field in order, and YEAR, sorted by branch number', async () => {
    const fake = new FakeFdic().on('sod', () => true, envelope('sod', [MAIN_OFFICE_BRANCH]));
    await serviceOver(fake).getBranches(
      {
        cert: 57701,
        year: 2026,
        geography: { state: WA, county: 'king', city: 'seattle', zip: '98101', msaCode: 42660 },
      },
      sodCtx(),
      callBudget(),
    );
    expect(fake.requests[0]?.params).toEqual({
      filters:
        'CERT:57701 AND STALPBR:"WA" AND CNTYNAMB:("king" OR "King") AND CITYBR:("seattle" OR "Seattle") AND ZIPBR:"98101" AND MSABR:42660 AND YEAR:2026',
      fields: BRANCH_FIELDS,
      sort_by: 'BRNUM',
      sort_order: 'ASC',
      limit: '10000',
      offset: '0',
    });
  });

  it('pages past 10,000 branches and names the institution from its first row', async () => {
    const rows = Array.from({ length: 10_002 }, (_, i) => sodBranch(i));
    const fake = new FakeFdic().on('sod', () => true, paged(rows));
    const found = await serviceOver(fake).getBranches(
      { cert: 57701, year: 2026 },
      sodCtx(),
      callBudget(),
    );
    expect(fake.requests.map((r) => [r.params.offset, r.params.limit])).toEqual([
      ['0', '10000'],
      ['10000', '10000'],
    ]);
    expect(found.rows).toHaveLength(10_002);
    expect(found.rows.at(-1)).toMatchObject({ branch_number: 10_001, branch_id: 610_001 });
    expect(found.institutionName).toBe('Evergreen Harbor Bank');
    expect(found.dataAsOf).toBe('2026-09-18T10:22:35Z');
  });

  it('returns no rows and no name for an institution without branches that year', async () => {
    const fake = new FakeFdic().on('sod', () => true, envelope('sod', []));
    const found = await serviceOver(fake).getBranches(
      { cert: 57701, year: 1995 },
      sodCtx(),
      callBudget(),
    );
    expect(found).toEqual({ rows: [], dataAsOf: '2026-09-18T10:22:35Z' });
    expect(fake.requests).toHaveLength(1);
  });

  it('normalizes sparse branch rows without inventing an MSA, date, or coordinates', async () => {
    const fake = new FakeFdic().on('sod', () => true, envelope('sod', [RURAL_BRANCH]));
    const found = await serviceOver(fake).getBranches(
      { cert: 57701, year: 2026 },
      sodCtx(),
      callBudget(),
    );
    expect(found.rows).toEqual([
      {
        branch_id: 377120,
        branch_number: 14,
        name: 'Walla Walla Branch',
        main_office: false,
        address: '12 East Main Street',
        city: 'Walla Walla',
        county: 'Walla Walla',
        state: 'WA',
        zip: '99362',
        deposits: 48210,
      },
    ]);
  });
});

describe('Summary of Deposits aggregations', () => {
  it('aggregates a market by CERT across every bucket, reading a bucket without a sum as 0', async () => {
    const fake = new FakeFdic().on(
      'sod',
      () => true,
      aggEnvelope('sod', 'CERT', [
        { key: '1001', count: 3, sums: { DEPSUMBR: 300 } },
        { key: '57701', count: 5 },
      ]),
    );
    const market = await serviceOver(fake).sodMarketByCert(
      { geography: { msaCode: 4260 }, year: 2026 },
      sodCtx(),
      callBudget(),
    );
    expect(fake.requests[0]?.params).toEqual({
      filters: 'MSABR:4260 AND YEAR:2026',
      agg_by: 'CERT',
      agg_sum_fields: 'DEPSUMBR',
      agg_limit: '10000',
      limit: '0',
    });
    expect([...market.buckets]).toEqual([
      [1001, { branchCount: 3, deposits: 300 }],
      [57701, { branchCount: 5, deposits: 0 }],
    ]);
  });

  it("sums every state's market for one survey year", async () => {
    const fake = new FakeFdic().on(
      'sod',
      () => true,
      aggEnvelope('sod', 'STALPBR', [
        { key: 'MA', count: 2000, sums: { DEPSUMBR: 20_000_000 } },
        { key: 'WA', count: 1800, sums: { DEPSUMBR: 50_000_000 } },
      ]),
    );
    const states = await serviceOver(fake).sodStateMarkets(2026, sodCtx(), callBudget());
    expect(fake.requests[0]?.params).toEqual({
      filters: 'YEAR:2026',
      agg_by: 'STALPBR',
      agg_sum_fields: 'DEPSUMBR',
      agg_limit: '10000',
      limit: '0',
    });
    expect(Object.fromEntries(states)).toEqual({
      MA: { branchCount: 2000, deposits: 20_000_000 },
      WA: { branchCount: 1800, deposits: 50_000_000 },
    });
  });
});

describe('institution names', () => {
  it('names a few CERTs in one request and skips records without a name', async () => {
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      envelope('institutions', [
        { CERT: 3003, NAME: 'Cascade Trust Bank', ID: '3003' },
        { CERT: 1001, NAME: '', ID: '1001' },
      ]),
    );
    const names = await serviceOver(fake).institutionNames(
      [3003, 1001, 2002],
      sodCtx(),
      callBudget(),
    );
    expect(fake.requests[0]?.params).toEqual({
      filters: 'CERT:(3003 OR 1001 OR 2002)',
      fields: 'CERT,NAME',
      limit: '3',
    });
    expect([...names]).toEqual([[3003, 'Cascade Trust Bank']]);
  });

  it('sends nothing for no CERTs', async () => {
    const fake = new FakeFdic();
    expect(await serviceOver(fake).institutionNames([], sodCtx(), callBudget())).toEqual(new Map());
    expect(fake.requests).toHaveLength(0);
  });

  it('builds the CERT→name directory from 10,000-row pages in CERT order', async () => {
    const records = Array.from({ length: 20_001 }, (_, i) => ({
      CERT: i + 1,
      NAME: `Bank ${i + 1}`,
      ID: String(i + 1),
    }));
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      paged(records, records.length, 'institutions'),
    );
    const directory = await serviceOver(fake).institutionDirectory(sodCtx(), callBudget());
    expect(fake.requests.map((r) => r.params)).toEqual(
      [0, 10_000, 20_000].map((offset) => ({
        fields: 'CERT,NAME',
        sort_by: 'CERT',
        sort_order: 'ASC',
        limit: '10000',
        offset: String(offset),
      })),
    );
    expect(directory.size).toBe(20_001);
    expect(directory.get(20_001)).toBe('Bank 20001');
  });
});

describe('panel preflight', () => {
  const filters: PanelFilters = {
    certs: [57701, 33990],
    state: WA,
    minAssets: 100_000,
    maxAssets: 5_000_000,
    metricFilters: [
      { metric: 'noncurrent_loan_rate', min: 3 },
      { metric: 'cet1_ratio', max: 8 },
    ],
  };

  it('counts rows per quarter in one aggregation, newest first, dropping empty buckets', async () => {
    const fake = new FakeFdic().on(
      'financials',
      () => true,
      aggEnvelope('financials', 'REPDTE', [
        { key: '20250930', count: 40 },
        { key: '20251231', count: 0 },
        { key: '20260331', count: 42 },
        { key: '20260630', count: 41 },
      ]),
    );
    const preflight = await serviceOver(fake).panelQuarterCounts(
      filters,
      '2025-09-30',
      '2026-06-30',
      panelCtx(),
      callBudget(),
    );
    expect(fake.requests[0]?.params).toEqual({
      filters:
        'REPDTE:[20250930 TO 20260630] AND CERT:(57701 OR 33990) AND STALP:"WA" AND ASSET:[100000 TO 5000000] AND NCLNLSR:[3 TO *] AND IDT1CER:[* TO 8] AND !(IDT1CER:0)',
      agg_by: 'REPDTE',
      agg_limit: '10000',
      limit: '0',
    });
    expect(preflight).toEqual({
      quarters: [
        { reportDate: '2026-06-30', rows: 41 },
        { reportDate: '2026-03-31', rows: 42 },
        { reportDate: '2025-09-30', rows: 40 },
      ],
      total: 123,
      dataAsOf: '2026-08-18T17:04:23Z',
    });
  });
});

describe('panel pages', () => {
  const identity = { NAME: 'BANK', STALP: 'WA' };
  const quarterOf = (request: FakeRequest) =>
    /REPDTE:"(\d{8})"/.exec(request.params.filters ?? '')?.[1];

  it('pages each planned quarter by CERT, stopping at its planned row count', async () => {
    const rows = Array.from({ length: 10_010 }, (_, i) =>
      panelRow(i + 1, '20260630', identity, { ASSET: i + 1 }),
    );
    const fake = new FakeFdic().on(
      'financials',
      () => true,
      (request) => {
        const offset = Number(request.params.offset);
        const limit = Number(request.params.limit);
        return envelope('financials', rows.slice(offset, offset + limit), { total: rows.length });
      },
    );
    const panel = await serviceOver(fake).getPanelRows(
      { state: WA },
      [{ reportDate: '2026-06-30', rows: 10_004 }],
      ['total_assets'],
      panelCtx(),
      callBudget(),
    );
    expect(fake.requests.map((r) => r.params)).toEqual([
      {
        filters: 'STALP:"WA" AND REPDTE:"20260630"',
        fields: 'CERT,NAME,STALP,REPDTE,ASSET',
        sort_by: 'CERT',
        sort_order: 'ASC',
        limit: '10000',
        offset: '0',
      },
      {
        filters: 'STALP:"WA" AND REPDTE:"20260630"',
        fields: 'CERT,NAME,STALP,REPDTE,ASSET',
        sort_by: 'CERT',
        sort_order: 'ASC',
        limit: '4',
        offset: '10000',
      },
    ]);
    expect(panel).toHaveLength(10_004);
    expect(panel.at(-1)).toEqual({
      cert: 10_004,
      name: 'BANK',
      state: 'WA',
      report_date: '2026-06-30',
      values: { total_assets: 10_004 },
    });
  });

  it('stops a quarter early on a short page, skips rows without a CERT, and nulls unreported ratios', async () => {
    const byQuarter: Record<string, Record<string, unknown>[]> = {
      '20260630': [
        panelRow(33990, '20260630', identity, { IDT1CER: 0 }),
        { NAME: 'NO CERT', STALP: 'WA', REPDTE: '20260630', IDT1CER: 9 },
      ],
      '20260331': [panelRow(33990, '20260331', identity, { IDT1CER: 12.5 })],
    };
    const fake = new FakeFdic().on(
      'financials',
      () => true,
      (request) => envelope('financials', byQuarter[quarterOf(request) ?? ''] ?? []),
    );
    const panel = await serviceOver(fake).getPanelRows(
      {},
      [
        { reportDate: '2026-06-30', rows: 500 },
        { reportDate: '2026-03-31', rows: 500 },
      ],
      ['cet1_ratio'],
      panelCtx(),
      callBudget(),
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((r) => r.params.filters)).toEqual([
      'REPDTE:"20260630"',
      'REPDTE:"20260331"',
    ]);
    expect(panel).toEqual([
      {
        cert: 33990,
        name: 'BANK',
        state: 'WA',
        report_date: '2026-06-30',
        values: { cet1_ratio: null },
      },
      {
        cert: 33990,
        name: 'BANK',
        state: 'WA',
        report_date: '2026-03-31',
        values: { cet1_ratio: 12.5 },
      },
    ]);
  });
});
