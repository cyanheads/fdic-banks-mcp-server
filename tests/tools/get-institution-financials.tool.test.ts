/**
 * @fileoverview Tests for fdic_get_institution_financials over a faked FDIC
 * transport: the two parallel requests, REPDTE-safe date windows, metric
 * selection and zero-means-unreported nulling, the empty-window, inactive, and
 * quarters-cap notices, both output surfaces, and every declared error reason.
 * @module tests/tools/get-institution-financials.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInstitutionFinancialsTool } from '@/mcp-server/tools/definitions/get-institution-financials.tool.js';
import { disposeFdicService } from '@/services/fdic/fdic-service.js';
import { ZERO_UNREPORTED_NOTE } from '@/services/fdic/metric-catalog.js';
import {
  DEFAULT_METRIC_FIELDS,
  FAILED_BANK,
  financialRow,
  HARBOR_BANK,
  healthRow,
  SOLO_BANK,
} from '../fixtures/fdic-records.js';
import { envelope, FakeFdic, INDEX, installFakeService } from '../helpers/fake-fdic.js';
import { structured, textOf, toolError } from '../helpers/tool-results.js';

type Output = z.infer<typeof getInstitutionFinancialsTool.output> & {
  cap?: number;
  notice?: string;
  shown?: number;
  truncated?: boolean;
};
type Input = z.input<typeof getInstitutionFinancialsTool.input>;

const tool = getInstitutionFinancialsTool;
const CERT = 57701;
const QUARTERS = ['20260630', '20260331', '20251231', '20250930'];

let fake: FakeFdic;

beforeEach(() => {
  fake = new FakeFdic();
  installFakeService(fake);
});

afterEach(() => {
  disposeFdicService();
});

/** The `/institutions` profile row; `null` for a CERT with no record. */
function withProfile(record: Record<string, unknown> | null = HARBOR_BANK) {
  fake.on('institutions', () => true, envelope('institutions', record ? [record] : []));
}

function withHistory(rows: Record<string, unknown>[], total = rows.length) {
  fake.on('financials', () => true, envelope('financials', rows, { total }));
}

function historyParams(): Readonly<Record<string, string>> {
  const request = fake.to('financials')[0];
  if (!request) throw new Error('No financials request was sent');
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

describe('requests', () => {
  it('reads the profile and the default-set history in two requests, most recent first', async () => {
    withProfile();
    withHistory(
      QUARTERS.map((q) => healthRow(CERT, q)),
      143,
    );
    await handle({ cert: CERT });

    expect(fake.to('institutions')[0]?.params).toMatchObject({ filters: 'CERT:57701', limit: '1' });
    expect(historyParams()).toEqual({
      filters: 'CERT:57701',
      fields: ['REPDTE', ...DEFAULT_METRIC_FIELDS].join(','),
      sort_by: 'REPDTE',
      sort_order: 'DESC',
      limit: '8',
    });
  });

  it.each<[string, Input, string]>([
    [
      'quarter labels and compact dates',
      { cert: CERT, from_date: '2025Q1', to_date: '20260630' },
      'CERT:57701 AND REPDTE:[20250331 TO 20260630]',
    ],
    [
      'a lowercase dashed label, open above',
      { cert: CERT, from_date: '2025-q3' },
      'CERT:57701 AND REPDTE:[20250930 TO *]',
    ],
    [
      'an ISO quarter end, open below',
      { cert: CERT, to_date: '2024-12-31' },
      'CERT:57701 AND REPDTE:[* TO 20241231]',
    ],
  ])('sends the window from %s as YYYYMMDD, never ISO', async (_label, input, filters) => {
    withProfile();
    withHistory([]);
    await handle(input);
    expect(historyParams().filters).toBe(filters);
  });

  it('treats blank dates as unset and an empty metrics list as the default set', async () => {
    withProfile();
    withHistory([]);
    const { result } = await run({ cert: CERT, from_date: '', to_date: '   ', metrics: [] });
    expect(result.isError).toBeFalsy();
    expect(historyParams().filters).toBe('CERT:57701');
    expect(historyParams().fields).toBe(['REPDTE', ...DEFAULT_METRIC_FIELDS].join(','));
  });

  it('requests only the named metrics, deduplicated, and caps the rows with quarters', async () => {
    withProfile();
    withHistory([]);
    await handle({
      cert: CERT,
      metrics: ['net_income_ytd', 'roa_ytd', 'insured_deposit_share', 'roa_ytd'],
      quarters: 200,
    });
    expect(historyParams()).toMatchObject({ fields: 'REPDTE,NETINC,ROA,ESTINS', limit: '200' });
  });
});

describe('output', () => {
  it('returns the profile, definitions, and ISO-dated rows with financials freshness', async () => {
    withProfile();
    withHistory(QUARTERS.slice(0, 2).map((q) => healthRow(CERT, q)));
    const { output } = await handle({ cert: CERT });

    expect(output.institution).toEqual({
      cert: 57701,
      name: 'Evergreen Harbor Bank',
      active: true,
      city: 'Tacoma',
      state: 'WA',
      holding_company: { name: 'EVERGREEN HARBOR BANCORP', rssd: 3456789 },
      last_report_date: '2026-06-30',
    });
    expect(output.metric_definitions).toHaveLength(15);
    expect(output.metric_definitions.find((d) => d.metric === 'net_income')).toEqual({
      metric: 'net_income',
      field: 'NETINCQ',
      unit: 'usd_thousands',
      basis: 'quarter',
    });
    expect(output.metric_definitions.find((d) => d.metric === 'leverage_ratio')?.note).toBe(
      ZERO_UNREPORTED_NOTE,
    );
    expect(output.rows.map((r) => r.report_date)).toEqual(['2026-06-30', '2026-03-31']);
    expect(output.rows[0]?.values).toMatchObject({
      total_assets: 2456123,
      roa: 1.16,
      net_income: 7123,
    });
    expect(output.quarters_available).toBe(2);
    expect(output.data_as_of).toBe(INDEX.financials.createTimestamp);
  });

  it('nulls unreported capital ratios of a leverage-ratio filer, keeps real zeros, nulls omitted fields', async () => {
    withProfile(SOLO_BANK);
    const cblrFiler = healthRow(33990, '20260630', {
      IDT1CER: 0,
      RBCRWAJ: 0,
      RBC1AAJ: 9.87,
      NCLNLSR: 0,
    });
    delete cblrFiler.DEPUNINS;
    withHistory([cblrFiler]);
    const { output } = await handle({ cert: 33990 });
    expect(output.rows[0]?.values).toMatchObject({
      cet1_ratio: null,
      total_risk_based_capital_ratio: null,
      leverage_ratio: 9.87,
      noncurrent_loan_rate: 0,
      uninsured_deposits: null,
    });
    expect(output.institution).not.toHaveProperty('holding_company');
  });

  it('reads an insured-deposit share of 0 as unreported', async () => {
    withProfile();
    withHistory([financialRow(CERT, '20081231', { ESTINS: 0 })]);
    const { output } = await handle({ cert: CERT, metrics: ['insured_deposit_share'] });
    expect(output.rows[0]?.values).toEqual({ insured_deposit_share: null });
  });
});

describe('notices', () => {
  it('explains an empty window with the last report date, as a success', async () => {
    withProfile();
    withHistory([]);
    const { output, enrichment } = await handle({
      cert: CERT,
      from_date: '1990Q1',
      to_date: '1990Q4',
    });
    expect(output.rows).toEqual([]);
    expect(output.quarters_available).toBe(0);
    expect(enrichment).toEqual({
      notice:
        'No Call Reports for CERT 57701 between 1990-03-31 and 1990-12-31; its reports run through 2026-06-30. Widen from_date/to_date or omit them.',
    });
  });

  it('names the inactive date, last report, and successor of a closed institution', async () => {
    withProfile(FAILED_BANK);
    withHistory([healthRow(24900, '20221231')]);
    const { output, enrichment } = await handle({ cert: 24900 });
    expect(output.institution).toMatchObject({
      active: false,
      ended_on: '2023-03-10',
      successor_cert: 58812,
      last_report_date: '2022-12-31',
    });
    expect(enrichment).toEqual({
      notice:
        'Inactive since 2023-03-10; its last report is 2022-12-31. Successor CERT 58812 continues the franchise.',
    });
  });

  it('marks the quarters cap as truncation, carrying the inactive notice with it', async () => {
    withProfile(FAILED_BANK);
    withHistory(
      QUARTERS.slice(0, 2).map((q) => healthRow(24900, q)),
      156,
    );
    const { enrichment } = await handle({ cert: 24900, quarters: 2 });
    expect(enrichment).toEqual({
      truncated: true,
      shown: 2,
      cap: 2,
      notice:
        'Inactive since 2023-03-10; its last report is 2022-12-31. Successor CERT 58812 continues the franchise. Showing the latest 2 of 156 quarters; raise quarters or narrow from_date/to_date.',
    });
  });

  it('adds no notice when every available quarter is returned', async () => {
    withProfile();
    withHistory(QUARTERS.map((q) => healthRow(CERT, q)));
    const { enrichment } = await handle({ cert: CERT });
    expect(enrichment).toEqual({});
  });
});

describe('both surfaces through the production contract', () => {
  it('validates the zero-result window with its notice on structuredContent and content[]', async () => {
    withProfile();
    withHistory([]);
    const { result, text } = await run({ cert: CERT, from_date: '1990Q1', to_date: '1990Q4' });
    const output = structured<Output>(result);
    expect(output.rows).toEqual([]);
    expect(output.notice).toMatch(/^No Call Reports for CERT 57701 between 1990-03-31/);
    expect(text).toContain('0 quarters available in the window; 0 shown.');
    expect(text).not.toContain('| Report date |');
    expect(text).toContain('> No Call Reports for CERT 57701');
  });

  it('validates an under-cap partial history with truncation on both surfaces', async () => {
    withProfile();
    withHistory(
      QUARTERS.slice(0, 3).map((q) => healthRow(CERT, q)),
      143,
    );
    const { result, text } = await run({ cert: CERT, quarters: 3 });
    const output = structured<Output>(result);
    expect(output).toMatchObject({ quarters_available: 143, truncated: true, shown: 3, cap: 3 });
    expect(output.rows).toHaveLength(3);
    expect(text).toContain('143 quarters available in the window; 3 shown.');
    expect(text).toContain('> Showing the latest 3 of 143 quarters');
  });

  it('renders the history table with units, dashes for unreported values, and the metric notes', async () => {
    withProfile();
    withHistory([
      healthRow(CERT, '20260630', { IDT1CER: 0 }),
      healthRow(CERT, '20260331', { ROAQ: -0.25 }),
    ]);
    const { text } = await run({
      cert: CERT,
      metrics: ['total_assets', 'roa', 'cet1_ratio', 'employees'],
    });
    expect(text).toContain('## Evergreen Harbor Bank — CERT 57701');
    expect(text).toContain('Active · Tacoma, WA');
    expect(text).toContain('Holding company: EVERGREEN HARBOR BANCORP (RSSD 3456789)');
    expect(text).toContain('last report 2026-06-30');
    expect(text).toContain('| Report date | total_assets | roa | cet1_ratio | employees |');
    expect(text).toContain('| 2026-06-30 | 2,456,123 | 1.16% | — | — |');
    expect(text).toContain('| 2026-03-31 | 2,456,123 | -0.25% | 13.4% | — |');
    expect(text).toContain('- roa: field ROAQ · unit percent · basis quarter_annualized');
    expect(text).toContain(
      `- cet1_ratio: field IDT1CER · unit percent · basis point_in_time — ${ZERO_UNREPORTED_NOTE}`,
    );
    expect(text).toContain(`Data as of ${INDEX.financials.createTimestamp}.`);
  });

  it('renders the lifecycle line of an inactive institution', async () => {
    withProfile(FAILED_BANK);
    withHistory([healthRow(24900, '20221231')]);
    const { text } = await run({ cert: 24900 });
    expect(text).toContain('Inactive · Santa Clara, CA');
    expect(text).toContain('last report 2022-12-31 · ended 2023-03-10 · successor CERT 58812');
  });
});

describe('errors', () => {
  it('fails cert_not_found when no institution record carries the CERT', async () => {
    withProfile(null);
    withHistory([]);
    const { result, text } = await run({ cert: 999999 });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'cert_not_found',
      recovery: {
        hint: 'Look up the CERT with fdic_search_institutions by name, then call this tool again with that CERT.',
      },
    });
    expect(text).toContain('reason cert_not_found');
  });

  it.each<[string, () => void]>([
    [
      'the shared request queue sheds the history call',
      () => {
        // The profile call takes the one slot; the history call is shed.
        const pacer = createPacer({ name: 'fdic-shed', limits: [{ requests: 1, perMs: 60_000 }] });
        installFakeService(fake, { pacer });
        withHistory([]);
      },
    ],
    [
      'FDIC throttles the history call',
      () => {
        fake.on(
          'financials',
          () => true,
          () => {
            throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
          },
        );
      },
    ],
  ])('fails cert_not_found for an unknown CERT even when %s', async (_label, failHistory) => {
    failHistory();
    withProfile(null);
    const { result } = await run({ cert: 999999 });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'cert_not_found' },
    });
  });

  it('reports the history failure for a CERT that exists', async () => {
    withProfile();
    fake.on(
      'financials',
      () => true,
      () => {
        throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
      },
    );
    const { result } = await run({ cert: CERT });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited' },
    });
  });

  it('fails invalid_date_range before any request when from_date is after to_date', async () => {
    const { result } = await run({ cert: CERT, from_date: '2026Q2', to_date: '20251231' });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_date_range');
    expect(error.data?.recovery?.hint).toBe(
      'Set from_date on or before to_date, or omit one of them.',
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('accepts a single-quarter window given in two different forms', async () => {
    withProfile();
    withHistory([healthRow(CERT, '20260630')]);
    const { result } = await run({ cert: CERT, from_date: '2026Q2', to_date: '2026-06-30' });
    expect(result.isError).toBeFalsy();
  });

  it('reports a saturated request queue as pacer_shed', async () => {
    const pacer = createPacer({ name: 'fdic-shed', limits: [{ requests: 1, perMs: 60_000 }] });
    installFakeService(fake, { pacer });
    withProfile();
    withHistory([]);
    const { result } = await run({ cert: CERT });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryable: true },
    });
  });

  it('reports an exhausted FDIC 429 as upstream_rate_limited', async () => {
    withProfile();
    fake.on(
      'financials',
      () => true,
      () => {
        throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '45' });
      },
    );
    const { result } = await run({ cert: CERT });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited', retryAfter: 45 },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a date that is not a quarter end', { from_date: '2025-02-28' }],
    ['a fifth quarter', { to_date: '2025Q5' }],
    ['an impossible compact date', { from_date: '20250332' }],
    ['a US-format date', { to_date: '06/30/2026' }],
    ['an unknown metric', { metrics: ['tier1_capital'] }],
    ['a raw FDIC field as a metric', { metrics: ['ROA'] }],
    ['more than 25 metrics', { metrics: Array.from({ length: 26 }, () => 'roa') }],
    ['quarters over 200', { quarters: 201 }],
    ['quarters 0', { quarters: 0 }],
  ])('rejects %s at the schema', async (_label, extra) => {
    const { result } = await run({ cert: CERT, ...extra } as Input);
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([0, -3, 1.5])('rejects cert %d at the schema', async (cert) => {
    const { result } = await run({ cert });
    expect(toolError(result).code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});
