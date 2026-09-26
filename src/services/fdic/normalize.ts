/**
 * @fileoverview Row normalizers: coerce numeric strings, convert dates to ISO, drop
 * empty strings and FDIC's absence sentinels to absent, and null the ratios FDIC
 * reports as `0` when unreported.
 * @module services/fdic/normalize
 */

import { bankClassLabel } from './bank-classes.js';
import { failureMethodLabel } from './failure-methods.js';
import { METRIC_CATALOG, type MetricName } from './metric-catalog.js';
import { usDateToIso } from './query-builder.js';
import type {
  BranchRecord,
  FailureRecord,
  FdicRow,
  InstitutionRecord,
  MetricValues,
} from './types.js';

/** A finite number from a number or numeric string; `null` otherwise. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A trimmed non-empty string; numbers stringified; `undefined` otherwise. */
export function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A string that is neither blank nor FDIC's `"0"` absence sentinel. */
function strNotZero(value: unknown): string | undefined {
  const s = str(value);
  return s === undefined || s === '0' ? undefined : s;
}

/** A positive number; `0` and blanks (FDIC's absence sentinels for IDs) read as absent. */
function positive(value: unknown): number | undefined {
  const n = num(value);
  return n !== null && n > 0 ? n : undefined;
}

/** `ENDEFYMD` of an active institution is the sentinel `12/31/9999`. */
function usDate(value: unknown): string | undefined {
  const s = str(value);
  if (s === undefined) return;
  const iso = usDateToIso(s);
  return iso === '9999-12-31' ? undefined : iso;
}

/** Optional-field helper that keeps `exactOptionalPropertyTypes` honest. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const EM_TAGS = /<\/?em>/g;

/** `PRIORNAME1..10` hold former names; `TE01N529..TE10N529` registered trade names. */
const FORMER_NAME_KEY = /^PRIORNAME\d+\.raw$/;
const TRADE_NAME_KEY = /^TE\d+N529\.raw$/;

/**
 * Which non-current name a `search=NAME:` hit matched, from the response's
 * `highlight`: absent when the current name matched.
 */
function matchedOn(
  highlight: Record<string, unknown> | undefined,
): InstitutionRecord['matched_on'] {
  if (!highlight || 'NAME.raw' in highlight) return;
  for (const [key, value] of Object.entries(highlight)) {
    const field = FORMER_NAME_KEY.test(key)
      ? 'former_name'
      : TRADE_NAME_KEY.test(key)
        ? 'trade_name'
        : undefined;
    const text = Array.isArray(value) ? str(value[0]) : undefined;
    if (field && text) return { field, text: text.replace(EM_TAGS, '') };
  }
  return;
}

export function normalizeInstitution(row: FdicRow): InstitutionRecord {
  const d = row.data;
  const bankClass = str(d.BKCLASS) ?? '';
  const holdingName = str(d.NAMEHCR);
  const holdingRssd = positive(d.RSSDHCR);
  const active = num(d.ACTIVE) === 1;
  return {
    cert: num(d.CERT) ?? 0,
    name: str(d.NAME) ?? '',
    active,
    city: str(d.CITY) ?? '',
    state: str(d.STALP) ?? '',
    ...opt('county', str(d.COUNTY)),
    bank_class: { code: bankClass, label: bankClassLabel(bankClass) },
    ...opt('regulator', str(d.REGAGNT)),
    ...opt('established_on', usDate(d.ESTYMD)),
    ...opt('insured_since', usDate(d.INSDATE)),
    ...opt('ended_on', active ? undefined : usDate(d.ENDEFYMD)),
    ...opt('successor_cert', positive(d.NEWCERT)),
    ...opt(
      'holding_company',
      holdingName ? { name: holdingName, ...opt('rssd', holdingRssd) } : undefined,
    ),
    ...opt('fed_rssd', positive(d.FED_RSSD)),
    ...opt('total_assets', num(d.ASSET) ?? undefined),
    ...opt('total_deposits', num(d.DEP) ?? undefined),
    ...opt('domestic_offices', num(d.OFFDOM) ?? undefined),
    ...opt('last_report_date', usDate(d.REPDTE)),
    ...opt('matched_on', matchedOn(row.highlight)),
  };
}

/** Metric values for one row: missing fields and zero-means-unreported ratios read `null`. */
export function metricValues(
  data: Record<string, unknown>,
  metrics: readonly MetricName[],
): MetricValues {
  const values: MetricValues = {};
  for (const metric of metrics) {
    const def = METRIC_CATALOG[metric];
    const value = num(data[def.field]);
    values[metric] = def.zeroMeansUnreported && value === 0 ? null : value;
  }
  return values;
}

/**
 * One Summary of Deposits branch row. `MSABR` is `0` for a non-metropolitan
 * branch (absent here) and otherwise rendered as a five-digit CBSA string.
 */
export function normalizeBranch(row: FdicRow): BranchRecord {
  const d = row.data;
  const msa = positive(d.MSABR);
  return {
    branch_id: num(d.UNINUMBR) ?? 0,
    branch_number: num(d.BRNUM) ?? 0,
    name: str(d.NAMEBR) ?? '',
    main_office: num(d.BKMO) === 1,
    address: str(d.ADDRESBR) ?? '',
    city: str(d.CITYBR) ?? '',
    county: str(d.CNTYNAMB) ?? '',
    state: str(d.STALPBR) ?? '',
    zip: str(d.ZIPBR) ?? '',
    ...opt('msa_code', msa === undefined ? undefined : String(msa).padStart(5, '0')),
    ...opt('msa_name', str(d.MSANAMB)),
    deposits: num(d.DEPSUMBR) ?? 0,
    ...opt('established_on', usDate(d.SIMS_ESTABLISHED_DATE)),
    ...opt('latitude', num(d.SIMS_LATITUDE) ?? undefined),
    ...opt('longitude', num(d.SIMS_LONGITUDE) ?? undefined),
  };
}

export function normalizeFailure(row: FdicRow): FailureRecord {
  const d = row.data;
  const method = str(d.RESTYPE1) ?? '';
  const acquirerName = strNotZero(d.BIDNAME);
  return {
    failure_id: str(d.ID) ?? '',
    ...opt('cert', positive(d.CERT)),
    ...opt('fin', strNotZero(d.FIN)),
    name: str(d.NAME) ?? '',
    city: str(d.CITY) ?? '',
    state: str(d.PSTALP) ?? '',
    failed_on: usDate(d.FAILDATE) ?? '',
    ...opt('resolved_on', usDate(d.RESDATE)),
    resolution: str(d.RESTYPE) ?? '',
    method,
    method_label: failureMethodLabel(method),
    insurance_fund: str(d.SAVR) ?? '',
    charter_class: str(d.CHCLASS1) ?? '',
    ...opt('total_assets', num(d.QBFASSET) ?? undefined),
    ...opt('total_deposits', num(d.QBFDEP) ?? undefined),
    ...opt('estimated_loss', num(d.COST) ?? undefined),
    ...opt('estimated_loss_as_of', str(d.COSTMOSTRECENTASOF)),
    ...opt(
      'acquirer',
      acquirerName
        ? {
            name: acquirerName,
            ...opt('city', strNotZero(d.BIDCITY)),
            ...opt('state', strNotZero(d.BIDSTATE)),
          }
        : undefined,
    ),
  };
}
