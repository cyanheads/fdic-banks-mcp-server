/**
 * @fileoverview The curated financial metric catalog: friendly names mapped to
 * FDIC `/financials` fields, with unit, quarter vs. year-to-date basis, the
 * default health set, and the zero-means-unreported flags.
 * @module services/fdic/metric-catalog
 */

/** How a metric accumulates over the reporting period. */
export type MetricBasis =
  | 'point_in_time'
  | 'quarter'
  | 'quarter_annualized'
  | 'year_to_date'
  | 'ytd_annualized';

/** Unit a metric's values carry. Dollar amounts are in thousands, as FDIC publishes them. */
export type MetricUnit = 'usd_thousands' | 'percent' | 'count';

export const METRIC_NAMES = [
  'total_assets',
  'total_liabilities',
  'total_deposits',
  'domestic_deposits',
  'insured_deposits',
  'uninsured_deposits',
  'insured_deposit_share',
  'brokered_deposits',
  'equity_capital',
  'net_loans',
  'securities',
  'cash_and_due',
  'real_estate_loans',
  'construction_loans',
  'multifamily_loans',
  'nonfarm_nonresidential_loans',
  'residential_mortgage_loans',
  'commercial_industrial_loans',
  'consumer_loans',
  'noncurrent_loans',
  'loan_loss_allowance',
  'other_real_estate_owned',
  'net_income',
  'net_income_ytd',
  'noninterest_income',
  'noninterest_expense',
  'provision_for_credit_losses',
  'net_charge_offs',
  'roa',
  'roa_ytd',
  'roe',
  'roe_ytd',
  'net_interest_margin',
  'net_interest_margin_ytd',
  'efficiency_ratio',
  'efficiency_ratio_ytd',
  'net_charge_off_rate',
  'net_charge_off_rate_ytd',
  'noncurrent_loan_rate',
  'nonperforming_asset_rate',
  'reserve_coverage',
  'loans_to_deposits',
  'equity_to_assets',
  'leverage_ratio',
  'cet1_ratio',
  'tier1_risk_based_ratio',
  'total_risk_based_capital_ratio',
  'employees',
  'domestic_offices',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** One catalog entry. */
export interface MetricDefinition {
  basis: MetricBasis;
  /** FDIC `/financials` field name — case-sensitive upstream. */
  field: string;
  label: string;
  metric: MetricName;
  note?: string;
  unit: MetricUnit;
  /** FDIC reports `0` for this ratio when the institution did not report it. */
  zeroMeansUnreported: boolean;
}

export const ZERO_UNREPORTED_NOTE =
  'Zero means not reported (not yet collected, community bank leverage ratio filer, or foreign-bank branch)';

type Entry = [field: string, unit: MetricUnit, basis: MetricBasis, label: string, note?: string];

const ENTRIES: Record<MetricName, Entry> = {
  total_assets: ['ASSET', 'usd_thousands', 'point_in_time', 'Total assets'],
  total_liabilities: ['LIAB', 'usd_thousands', 'point_in_time', 'Total liabilities'],
  total_deposits: ['DEP', 'usd_thousands', 'point_in_time', 'Total deposits'],
  domestic_deposits: ['DEPDOM', 'usd_thousands', 'point_in_time', 'Deposits in domestic offices'],
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
  ],
  brokered_deposits: ['BRO', 'usd_thousands', 'point_in_time', 'Brokered deposits'],
  equity_capital: ['EQ', 'usd_thousands', 'point_in_time', 'Total equity capital'],
  net_loans: ['LNLSNET', 'usd_thousands', 'point_in_time', 'Net loans and leases'],
  securities: ['SC', 'usd_thousands', 'point_in_time', 'Total securities'],
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
    'Commercial real estate',
  ],
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
  leverage_ratio: ['RBC1AAJ', 'percent', 'point_in_time', 'Tier 1 leverage ratio'],
  cet1_ratio: ['IDT1CER', 'percent', 'point_in_time', 'Common equity tier 1 capital ratio'],
  tier1_risk_based_ratio: [
    'IDT1RWAJR',
    'percent',
    'point_in_time',
    'Tier 1 risk-based capital ratio',
  ],
  total_risk_based_capital_ratio: [
    'RBCRWAJ',
    'percent',
    'point_in_time',
    'Total risk-based capital ratio',
  ],
  employees: ['NUMEMP', 'count', 'point_in_time', 'Employees', 'Full-time equivalent'],
  domestic_offices: ['OFFDOM', 'count', 'point_in_time', 'Domestic offices'],
};

/** Fields FDIC reports as `0` when the ratio was not reported. */
const ZERO_UNREPORTED_FIELDS = new Set(['ESTINS', 'RBC1AAJ', 'IDT1CER', 'IDT1RWAJR', 'RBCRWAJ']);

export const METRIC_CATALOG: Record<MetricName, MetricDefinition> = Object.fromEntries(
  METRIC_NAMES.map((metric) => {
    const [field, unit, basis, label, note] = ENTRIES[metric];
    const zeroMeansUnreported = ZERO_UNREPORTED_FIELDS.has(field);
    const resolvedNote = zeroMeansUnreported ? ZERO_UNREPORTED_NOTE : note;
    const definition: MetricDefinition = {
      metric,
      field,
      unit,
      basis,
      label,
      zeroMeansUnreported,
      ...(resolvedNote ? { note: resolvedNote } : {}),
    };
    return [metric, definition];
  }),
) as Record<MetricName, MetricDefinition>;

/** Metrics returned when a caller omits `metrics`. */
export const DEFAULT_METRICS: readonly MetricName[] = [
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
];

const DEFAULT_SET = new Set<MetricName>(DEFAULT_METRICS);

/** True when the metric is part of the default health set. */
export function isDefaultMetric(metric: MetricName): boolean {
  return DEFAULT_SET.has(metric);
}

/** The requested metrics, deduplicated in request order, or the default set when none. */
export function resolveMetrics(requested: readonly MetricName[] | undefined): MetricName[] {
  return requested?.length ? [...new Set(requested)] : [...DEFAULT_METRICS];
}

/** The self-describing definition block a response carries for its metrics. */
export function metricDefinitions(metrics: readonly MetricName[]) {
  return metrics.map((metric) => {
    const { field, unit, basis, note } = METRIC_CATALOG[metric];
    return { metric, field, unit, basis, ...(note ? { note } : {}) };
  });
}
