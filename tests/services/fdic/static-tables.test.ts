/**
 * @fileoverview Tests for the static vocabulary modules: metric catalog, state
 * table, asset bands, bank classes, failure methods, insurance funds, coverage,
 * and the `/history` change codes.
 * @module tests/services/fdic/static-tables.test
 */

import { describe, expect, it } from 'vitest';
import { ASSET_BAND_CODES, assetBand, assetBandFor } from '@/services/fdic/asset-bands.js';
import { BANK_CLASS_CODES, bankClassLabel } from '@/services/fdic/bank-classes.js';
import { CHANGE_CODES, changeCode } from '@/services/fdic/change-codes.js';
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
  it('holds 60 unique curated metrics on 60 distinct uppercase FDIC fields', () => {
    expect(METRIC_NAMES).toHaveLength(60);
    expect(new Set(METRIC_NAMES).size).toBe(60);
    for (const name of METRIC_NAMES) {
      const def = METRIC_CATALOG[name];
      expect(def.metric).toBe(name);
      expect(def.field).toMatch(/^[A-Z0-9]+$/);
    }
    expect(new Set(METRIC_NAMES.map((m) => METRIC_CATALOG[m].field)).size).toBe(60);
  });

  it('maps every metric to its FDIC field, unit, basis, label, and note', () => {
    const Z = ZERO_UNREPORTED_NOTE;
    const table = Object.fromEntries(
      metricDefinitions(METRIC_NAMES).map(({ metric, field, unit, basis, note }) => {
        const { label } = METRIC_CATALOG[metric];
        return [
          metric,
          note === undefined ? [field, unit, basis, label] : [field, unit, basis, label, note],
        ];
      }),
    );
    expect(table).toEqual({
      total_assets: ['ASSET', 'usd_thousands', 'point_in_time', 'Total assets'],
      total_liabilities: ['LIAB', 'usd_thousands', 'point_in_time', 'Total liabilities'],
      total_deposits: ['DEP', 'usd_thousands', 'point_in_time', 'Total deposits'],
      domestic_deposits: [
        'DEPDOM',
        'usd_thousands',
        'point_in_time',
        'Deposits in domestic offices',
      ],
      insured_deposits: [
        'DEPINS',
        'usd_thousands',
        'point_in_time',
        'Estimated insured deposits',
        'Estimated; null before FDIC collected it',
      ],
      uninsured_deposits: [
        'DEPUNINS',
        'usd_thousands',
        'point_in_time',
        'Estimated uninsured deposits',
        'Estimated, domestic offices',
      ],
      insured_deposit_share: [
        'ESTINS',
        'percent',
        'point_in_time',
        'Estimated insured share of domestic deposits',
        Z,
      ],
      brokered_deposits: ['BRO', 'usd_thousands', 'point_in_time', 'Brokered deposits'],
      equity_capital: ['EQ', 'usd_thousands', 'point_in_time', 'Total equity capital'],
      tier1_capital: ['RBCT1J', 'usd_thousands', 'point_in_time', 'Tier 1 (core) capital'],
      total_risk_based_capital: [
        'RBC',
        'usd_thousands',
        'point_in_time',
        'Total risk-based capital',
        Z,
      ],
      risk_weighted_assets: [
        'RWAJ',
        'usd_thousands',
        'point_in_time',
        'Total risk-weighted assets',
        Z,
      ],
      net_loans: ['LNLSNET', 'usd_thousands', 'point_in_time', 'Net loans and leases'],
      securities: ['SC', 'usd_thousands', 'point_in_time', 'Total securities'],
      held_to_maturity_amortized_cost: [
        'SCHA',
        'usd_thousands',
        'point_in_time',
        'Held-to-maturity securities at amortized cost',
      ],
      held_to_maturity_fair_value: [
        'SCHF',
        'usd_thousands',
        'point_in_time',
        'Held-to-maturity securities at fair value',
      ],
      available_for_sale_amortized_cost: [
        'SCAA',
        'usd_thousands',
        'point_in_time',
        'Available-for-sale securities at amortized cost',
      ],
      available_for_sale_fair_value: [
        'SCAF',
        'usd_thousands',
        'point_in_time',
        'Available-for-sale debt securities at fair value',
      ],
      cash_and_due: ['CHBAL', 'usd_thousands', 'point_in_time', 'Cash and balances due'],
      real_estate_loans: ['LNRE', 'usd_thousands', 'point_in_time', 'Real estate loans'],
      construction_loans: [
        'LNRECONS',
        'usd_thousands',
        'point_in_time',
        'Construction and land development loans',
        'Construction and land development',
      ],
      multifamily_loans: [
        'LNREMULT',
        'usd_thousands',
        'point_in_time',
        'Multifamily real estate loans',
      ],
      nonfarm_nonresidential_loans: [
        'LNRENRES',
        'usd_thousands',
        'point_in_time',
        'Nonfarm nonresidential real estate loans',
        'Includes owner-occupied loans; the interagency CRE concentration test counts only the non-owner-occupied part',
      ],
      nonfarm_nonresidential_non_owner_occupied_loans: [
        'LNRENROT',
        'usd_thousands',
        'point_in_time',
        'Non-owner-occupied nonfarm nonresidential real estate loans',
        'Null before 2007',
      ],
      farmland_loans: ['LNREAG', 'usd_thousands', 'point_in_time', 'Loans secured by farmland'],
      residential_mortgage_loans: [
        'LNRERES',
        'usd_thousands',
        'point_in_time',
        'Residential mortgage loans',
        '1–4 family',
      ],
      commercial_industrial_loans: [
        'LNCI',
        'usd_thousands',
        'point_in_time',
        'Commercial and industrial loans',
      ],
      agricultural_production_loans: [
        'LNAG',
        'usd_thousands',
        'point_in_time',
        'Loans to finance agricultural production and other loans to farmers',
      ],
      cre_loans_not_secured_by_real_estate: [
        'LNCOMRE',
        'usd_thousands',
        'point_in_time',
        'Commercial real estate loans not secured by real estate',
      ],
      consumer_loans: ['LNCON', 'usd_thousands', 'point_in_time', 'Consumer loans'],
      noncurrent_loans: ['NCLNLS', 'usd_thousands', 'point_in_time', 'Noncurrent loans and leases'],
      loan_loss_allowance: [
        'LNATRES',
        'usd_thousands',
        'point_in_time',
        'Allowance for loan and lease losses',
      ],
      other_real_estate_owned: ['ORE', 'usd_thousands', 'point_in_time', 'Other real estate owned'],
      net_income: ['NETINCQ', 'usd_thousands', 'quarter', 'Net income (quarter)'],
      net_income_ytd: ['NETINC', 'usd_thousands', 'year_to_date', 'Net income (year to date)'],
      noninterest_income: ['NONIIQ', 'usd_thousands', 'quarter', 'Noninterest income (quarter)'],
      noninterest_expense: ['NONIXQ', 'usd_thousands', 'quarter', 'Noninterest expense (quarter)'],
      provision_for_credit_losses: [
        'ELNATQ',
        'usd_thousands',
        'quarter',
        'Provision for credit losses (quarter)',
      ],
      net_charge_offs: ['NTLNLSQ', 'usd_thousands', 'quarter', 'Net charge-offs (quarter)'],
      roa: ['ROAQ', 'percent', 'quarter_annualized', 'Return on assets (quarter, annualized)'],
      roa_ytd: ['ROA', 'percent', 'ytd_annualized', 'Return on assets (year to date, annualized)'],
      roe: ['ROEQ', 'percent', 'quarter_annualized', 'Return on equity (quarter, annualized)'],
      roe_ytd: ['ROE', 'percent', 'ytd_annualized', 'Return on equity (year to date, annualized)'],
      net_interest_margin: [
        'NIMYQ',
        'percent',
        'quarter_annualized',
        'Net interest margin (quarter, annualized)',
      ],
      net_interest_margin_ytd: [
        'NIMY',
        'percent',
        'ytd_annualized',
        'Net interest margin (year to date, annualized)',
      ],
      efficiency_ratio: [
        'EEFFQR',
        'percent',
        'quarter',
        'Efficiency ratio (quarter)',
        'Noninterest expense / revenue',
      ],
      efficiency_ratio_ytd: ['EEFFR', 'percent', 'year_to_date', 'Efficiency ratio (year to date)'],
      net_charge_off_rate: [
        'NTLNLSQR',
        'percent',
        'quarter_annualized',
        'Net charge-off rate (quarter, annualized)',
      ],
      net_charge_off_rate_ytd: [
        'NTLNLSR',
        'percent',
        'ytd_annualized',
        'Net charge-off rate (year to date, annualized)',
      ],
      noncurrent_loan_rate: [
        'NCLNLSR',
        'percent',
        'point_in_time',
        'Noncurrent loan rate',
        'Noncurrent / gross loans',
      ],
      nonperforming_asset_rate: [
        'NPERFV',
        'percent',
        'point_in_time',
        'Nonperforming asset rate',
        'Nonperforming / total assets',
      ],
      reserve_coverage: [
        'LNRESNCR',
        'percent',
        'point_in_time',
        'Reserve coverage of noncurrent loans',
        'Allowance / noncurrent loans',
      ],
      loans_to_deposits: ['LNLSDEPR', 'percent', 'point_in_time', 'Net loans to deposits'],
      equity_to_assets: ['EQV', 'percent', 'point_in_time', 'Equity capital to assets'],
      leverage_ratio: ['RBC1AAJ', 'percent', 'point_in_time', 'Tier 1 leverage ratio', Z],
      cet1_ratio: ['IDT1CER', 'percent', 'point_in_time', 'Common equity tier 1 capital ratio', Z],
      tier1_risk_based_ratio: [
        'IDT1RWAJR',
        'percent',
        'point_in_time',
        'Tier 1 risk-based capital ratio',
        Z,
      ],
      total_risk_based_capital_ratio: [
        'RBCRWAJ',
        'percent',
        'point_in_time',
        'Total risk-based capital ratio',
        Z,
      ],
      employees: ['NUMEMP', 'count', 'point_in_time', 'Employees', 'Full-time equivalent'],
      domestic_offices: ['OFFDOM', 'count', 'point_in_time', 'Domestic offices'],
    });
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

  it('flags exactly the four capital ratios, ESTINS, RBC, and RWAJ as zero-means-unreported, with the note', () => {
    const flagged = METRIC_NAMES.filter((m) => METRIC_CATALOG[m].zeroMeansUnreported);
    expect(flagged.sort()).toEqual(
      [
        'cet1_ratio',
        'insured_deposit_share',
        'leverage_ratio',
        'risk_weighted_assets',
        'tier1_risk_based_ratio',
        'total_risk_based_capital',
        'total_risk_based_capital_ratio',
      ].sort(),
    );
    expect(flagged.map((m) => METRIC_CATALOG[m].field).sort()).toEqual(
      ['ESTINS', 'IDT1CER', 'IDT1RWAJR', 'RBC', 'RBC1AAJ', 'RBCRWAJ', 'RWAJ'].sort(),
    );
    expect(ZERO_UNREPORTED_NOTE).toBe(
      'Zero means not reported (not yet collected, community bank leverage ratio filer, uninsured trust company, or foreign-bank branch)',
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
      [
        'history',
        '1969 for mergers and 1970 for failures; founding records carry dates back to 1782',
      ],
      ['institutions', '1934'],
    ]);
  });
});

describe('structure-change codes', () => {
  it('holds the 41 codes of the live index, unique, ascending, each with a label', () => {
    const codes = CHANGE_CODES.map((c) => c.code);
    expect(codes).toHaveLength(41);
    expect(new Set(codes).size).toBe(41);
    expect(codes).toEqual(codes.toSorted((a, b) => a - b));
    for (const c of CHANGE_CODES) expect(c.label.trim()).not.toBe('');
  });

  it('maps codes to event types as the history tool classifies them', () => {
    const byType = Object.groupBy(CHANGE_CODES, (c) => c.eventType);
    const codesOf = (type: string) =>
      (byType[type as keyof typeof byType] ?? []).map((c) => c.code);
    expect(codesOf('opening')).toEqual([1, 110]);
    expect(codesOf('merger')).toEqual([221, 222, 223, 224, 225, 810]);
    expect(codesOf('failure_or_assistance')).toEqual([
      211, 213, 215, 216, 217, 230, 235, 350, 360, 811, 812, 830,
    ]);
    expect(codesOf('branch_purchase')).toEqual([712]);
    expect(codesOf('name_change')).toEqual([510]);
    expect(codesOf('relocation')).toEqual([520]);
    expect(codesOf('closing')).toEqual([240, 260]);
    expect(codesOf('charter_change')).toEqual([
      150, 310, 320, 340, 410, 420, 430, 440, 470, 610, 820,
    ]);
    expect(codesOf('branch')).toEqual([711, 713, 721, 722, 724]);
    expect(codesOf('other')).toEqual([]);
  });

  it('records 520 and 712 at both levels, the branch codes at branch level, the rest at institution level', () => {
    const levels = new Map(CHANGE_CODES.map((c) => [c.code, c.level]));
    expect([...levels].filter(([, level]) => level === 'both').map(([code]) => code)).toEqual([
      520, 712,
    ]);
    expect([...levels].filter(([, level]) => level === 'branch').map(([code]) => code)).toEqual([
      711, 713, 721, 722, 724,
    ]);
  });

  it('marks the outgoing side (211–225) and the survivor side (810–812) of an exit', () => {
    const side = (s: string) => CHANGE_CODES.filter((c) => c.side === s).map((c) => c.code);
    expect(side('outgoing')).toEqual([211, 213, 215, 216, 217, 221, 222, 223, 224, 225]);
    expect(side('survivor')).toEqual([810, 811, 812]);
  });

  it('keeps FDIC labels verbatim and finds an entry by code, leaving a new code unmapped', () => {
    expect(changeCode(221)?.label).toBe('Absorbtion - Without Assistance');
    expect(changeCode(223)?.label).toBe('Merger -Without Assistance');
    expect(changeCode(999)).toBeUndefined();
  });
});
