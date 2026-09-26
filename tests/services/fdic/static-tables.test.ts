/**
 * @fileoverview Tests for the static vocabulary modules: metric catalog, state
 * table, asset bands, bank classes, failure methods, insurance funds, coverage.
 * @module tests/services/fdic/static-tables.test
 */

import { describe, expect, it } from 'vitest';
import { ASSET_BAND_CODES, assetBand, assetBandFor } from '@/services/fdic/asset-bands.js';
import { BANK_CLASS_CODES, bankClassLabel } from '@/services/fdic/bank-classes.js';
import { COVERAGE } from '@/services/fdic/coverage.js';
import { FAILURE_METHOD_CODES, failureMethodLabel } from '@/services/fdic/failure-methods.js';
import { INSURANCE_FUNDS } from '@/services/fdic/insurance-funds.js';
import {
  DEFAULT_METRICS,
  isDefaultMetric,
  METRIC_CATALOG,
  METRIC_NAMES,
  metricDefinitions,
  resolveMetrics,
  ZERO_UNREPORTED_NOTE,
} from '@/services/fdic/metric-catalog.js';
import { normalizeState, US_STATES } from '@/services/fdic/us-states.js';

describe('metric catalog', () => {
  it('holds 49 unique curated metrics, each mapped to an uppercase FDIC field', () => {
    expect(METRIC_NAMES).toHaveLength(49);
    expect(new Set(METRIC_NAMES).size).toBe(49);
    for (const name of METRIC_NAMES) {
      const def = METRIC_CATALOG[name];
      expect(def.metric).toBe(name);
      expect(def.field).toMatch(/^[A-Z0-9]+$/);
    }
    expect(new Set(METRIC_NAMES.map((m) => METRIC_CATALOG[m].field)).size).toBe(49);
  });

  it('maps unsuffixed income and return metrics to single-quarter fields and _ytd to year-to-date', () => {
    const quarter = {
      net_income: ['NETINCQ', 'quarter'],
      roa: ['ROAQ', 'quarter_annualized'],
      roe: ['ROEQ', 'quarter_annualized'],
      net_interest_margin: ['NIMYQ', 'quarter_annualized'],
      efficiency_ratio: ['EEFFQR', 'quarter'],
      net_charge_off_rate: ['NTLNLSQR', 'quarter_annualized'],
    } as const;
    const ytd = {
      net_income_ytd: ['NETINC', 'year_to_date'],
      roa_ytd: ['ROA', 'ytd_annualized'],
      roe_ytd: ['ROE', 'ytd_annualized'],
      net_interest_margin_ytd: ['NIMY', 'ytd_annualized'],
      efficiency_ratio_ytd: ['EEFFR', 'year_to_date'],
      net_charge_off_rate_ytd: ['NTLNLSR', 'ytd_annualized'],
    } as const;
    for (const [metric, [field, basis]] of Object.entries({ ...quarter, ...ytd })) {
      expect(METRIC_CATALOG[metric as keyof typeof METRIC_CATALOG]).toMatchObject({ field, basis });
    }
  });

  it('flags exactly the four capital ratios and ESTINS as zero-means-unreported, with the note', () => {
    const flagged = METRIC_NAMES.filter((m) => METRIC_CATALOG[m].zeroMeansUnreported);
    expect(flagged.sort()).toEqual(
      [
        'cet1_ratio',
        'insured_deposit_share',
        'leverage_ratio',
        'tier1_risk_based_ratio',
        'total_risk_based_capital_ratio',
      ].sort(),
    );
    expect(flagged.map((m) => METRIC_CATALOG[m].field).sort()).toEqual(
      ['ESTINS', 'IDT1CER', 'IDT1RWAJR', 'RBC1AAJ', 'RBCRWAJ'].sort(),
    );
    for (const m of flagged) expect(METRIC_CATALOG[m].note).toBe(ZERO_UNREPORTED_NOTE);
  });

  it('labels units: dollars in thousands, ratios in percent, headcounts as count', () => {
    expect(METRIC_CATALOG.total_assets.unit).toBe('usd_thousands');
    expect(METRIC_CATALOG.roa.unit).toBe('percent');
    expect(METRIC_CATALOG.employees.unit).toBe('count');
    expect(METRIC_CATALOG.domestic_offices.unit).toBe('count');
  });

  it('defines the 15-metric default health set from the design', () => {
    expect(DEFAULT_METRICS).toEqual([
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
    expect(isDefaultMetric('roa')).toBe(true);
    expect(isDefaultMetric('roa_ytd')).toBe(false);
  });

  it('resolves the default set for omitted or empty metrics and dedupes in request order', () => {
    expect(resolveMetrics(undefined)).toEqual([...DEFAULT_METRICS]);
    expect(resolveMetrics([])).toEqual([...DEFAULT_METRICS]);
    expect(resolveMetrics(['roe', 'roa', 'roe'])).toEqual(['roe', 'roa']);
  });

  it('builds definition blocks with a note only where the catalog has one', () => {
    expect(metricDefinitions(['total_assets', 'cet1_ratio'])).toEqual([
      { metric: 'total_assets', field: 'ASSET', unit: 'usd_thousands', basis: 'point_in_time' },
      {
        metric: 'cet1_ratio',
        field: 'IDT1CER',
        unit: 'percent',
        basis: 'point_in_time',
        note: ZERO_UNREPORTED_NOTE,
      },
    ]);
  });
});

describe('us-states', () => {
  it('covers the 50 states, DC, and five territories', () => {
    expect(Object.keys(US_STATES)).toHaveLength(56);
    for (const code of ['DC', 'PR', 'GU', 'VI', 'AS', 'MP']) expect(US_STATES).toHaveProperty(code);
  });

  it.each([
    ['wa', 'WA'],
    ['WA', 'WA'],
    [' Wa ', 'WA'],
    ['Washington', 'WA'],
    ['new   york', 'NY'],
    ['District of Columbia', 'DC'],
    ['Washington, D.C.', 'DC'],
    ['virgin islands', 'VI'],
    ['U.S. Virgin Islands', 'VI'],
    ['puerto rico', 'PR'],
  ])('normalizes %j to %s', (input, code) => {
    expect(normalizeState(input)).toBe(code);
  });

  it.each(['XX', 'Atlantis', 'W', 'Wash', ''])('rejects %j', (input) => {
    expect(normalizeState(input)).toBeUndefined();
  });
});

describe('asset bands', () => {
  it.each([
    [0, 'under_100m'],
    [99_999, 'under_100m'],
    [100_000, '100m_1b'],
    [999_999.9, '100m_1b'],
    [1_000_000, '1b_10b'],
    [9_999_999, '1b_10b'],
    [10_000_000, '10b_250b'],
    [249_999_999, '10b_250b'],
    [250_000_000, 'over_250b'],
    [4_000_000_000, 'over_250b'],
  ])('places %d (USD thousands) in %s', (assets, code) => {
    expect(assetBandFor(assets).code).toBe(code);
  });

  it('tiles the number line with inclusive lower and exclusive upper bounds', () => {
    const bands = ASSET_BAND_CODES.map(assetBand);
    expect(bands[0]).not.toHaveProperty('min');
    expect(bands.at(-1)).not.toHaveProperty('max');
    for (let i = 1; i < bands.length; i++) expect(bands[i]?.min).toBe(bands[i - 1]?.max);
  });
});

describe('code labels', () => {
  it('labels every bank class and names an unknown one instead of guessing', () => {
    for (const code of BANK_CLASS_CODES) expect(bankClassLabel(code)).not.toMatch(/not in this/);
    expect(bankClassLabel('ZZ')).toBe("Class code ZZ (not in this server's class table)");
  });

  it('labels every failure method and names an unknown one instead of guessing', () => {
    for (const code of FAILURE_METHOD_CODES) expect(failureMethodLabel(code)).not.toMatch(/not in/);
    expect(failureMethodLabel('XYZ')).toBe("Method code XYZ (not in this server's method table)");
  });

  it('lists the six insurance funds', () => {
    expect(Object.keys(INSURANCE_FUNDS)).toEqual(['DIF', 'BIF', 'SAIF', 'RTC', 'FSLIC', 'FDIC']);
  });

  it('describes each dataset window', () => {
    expect(COVERAGE.map((c) => [c.code, c.starts])).toEqual([
      ['financials', '1984Q1 (1984-03-31)'],
      ['summary_of_deposits', '1994'],
      ['failures', '1934'],
      ['institutions', '1934'],
    ]);
  });
});
