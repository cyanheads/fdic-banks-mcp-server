/**
 * @fileoverview BankFind response envelope and the normalized record shapes the
 * FDIC service returns to tools.
 * @module services/fdic/types
 */

import type { FailureMethodCode } from './failure-methods.js';
import type { MetricName } from './metric-catalog.js';
import type { StateCode } from './us-states.js';

/** One BankFind row wrapper. Aggregation rows carry only `data`. */
export interface FdicRow {
  data: Record<string, unknown>;
  /** `<FIELD>.raw` → matched text with `<em>` tags; name searches only. */
  highlight?: Record<string, unknown>;
}

/** BankFind response envelope, after shape validation. */
export interface FdicEnvelope {
  /** Upstream index build timestamp (`meta.index.createTimestamp`). */
  dataAsOf: string;
  rows: FdicRow[];
  /** `meta.total` — matching rows upstream. */
  total: number;
  /** `totals` block: `count`, `total_fields` sums, `subtotal_by_<FIELD>[]`, `sum_<FIELD>`. */
  totals: Record<string, unknown>;
}

/** Tool call deadline, as a wall-clock instant. */
export interface CallBudget {
  deadlineAt: number;
}

export type InstitutionStatus = 'active' | 'inactive' | 'any';

export interface InstitutionRecord {
  active: boolean;
  bank_class: { code: string; label: string };
  cert: number;
  city: string;
  county?: string;
  domestic_offices?: number;
  ended_on?: string;
  established_on?: string;
  fed_rssd?: number;
  holding_company?: { name: string; rssd?: number };
  insured_since?: string;
  last_report_date?: string;
  matched_on?: { field: 'former_name' | 'trade_name'; text: string };
  name: string;
  regulator?: string;
  state: string;
  successor_cert?: number;
  total_assets?: number;
  total_deposits?: number;
}

/** Metric values for one institution-quarter; `null` when not reported. */
export type MetricValues = Partial<Record<MetricName, number | null>>;

export interface FinancialRow {
  report_date: string;
  values: MetricValues;
}

export interface FailureRecord {
  acquirer?: { name: string; city?: string; state?: string };
  cert?: number;
  charter_class: string;
  city: string;
  estimated_loss?: number;
  estimated_loss_as_of?: string;
  failed_on: string;
  failure_id: string;
  fin?: string;
  insurance_fund: string;
  method: string;
  method_label: string;
  name: string;
  resolution: string;
  resolved_on?: string;
  state: string;
  total_assets?: number;
  total_deposits?: number;
}

/** Filter set shared by every `/failures` call a search makes. */
export interface FailureFilters {
  certs?: readonly number[];
  /** ISO date, inclusive. */
  from?: string;
  methods?: readonly FailureMethodCode[];
  minAssets?: number;
  /** Tokens from `nameTokens`. */
  nameTokens?: readonly string[];
  resolution: 'failure' | 'assistance' | 'all';
  state?: StateCode;
  /** ISO date, inclusive. */
  to?: string;
}

export type FailureGroupBy = 'year' | 'state' | 'method' | 'insurance_fund';

export type FailureSort = 'date_desc' | 'date_asc' | 'loss_desc' | 'assets_desc';

/** Sums over a set of failure events. `cost` covers only events with an estimate. */
export interface FailureTotals {
  assets: number;
  cost: number;
  count: number;
  deposits: number;
}

export interface FailureBucket extends FailureTotals {
  key: string;
}

/** One metric threshold on a financial panel; at least one bound is set. */
export interface MetricFilter {
  max?: number;
  metric: MetricName;
  min?: number;
}

/** Filter set a financial panel's preflight and per-quarter pages share. */
export interface PanelFilters {
  certs?: readonly number[];
  maxAssets?: number;
  metricFilters?: readonly MetricFilter[];
  minAssets?: number;
  state?: StateCode;
}

/** A panel quarter and its row count (matching rows, or the rows planned to fetch). */
export interface PanelQuarter {
  /** ISO quarter-end date. */
  reportDate: string;
  rows: number;
}

/** One institution-quarter of a financial panel. */
export interface PanelRow {
  cert: number;
  /** Name as filed on the Call Report for the quarter. */
  name: string;
  report_date: string;
  state: string;
  values: MetricValues;
}

/** A Summary of Deposits geography; every set field narrows the branch rows. */
export interface SodGeography {
  city?: string;
  /** County name with any trailing " County" already stripped. */
  county?: string;
  /** CBSA code as a number (`MSABR` is numeric upstream). */
  msaCode?: number;
  state?: StateCode;
  /** Five-digit ZIP as a string (`ZIPBR` is a string upstream). */
  zip?: string;
}

/** One Summary of Deposits branch row. Deposits are USD thousands as of June 30. */
export interface BranchRecord {
  address: string;
  branch_id: number;
  branch_number: number;
  city: string;
  county: string;
  deposits: number;
  established_on?: string;
  latitude?: number;
  longitude?: number;
  main_office: boolean;
  msa_code?: string;
  msa_name?: string;
  name: string;
  state: string;
  zip: string;
}

/** Branch count and deposit sum for one aggregation key (a CERT or a state). */
export interface SodBucket {
  branchCount: number;
  deposits: number;
}
