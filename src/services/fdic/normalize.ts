/**
 * @fileoverview Row normalizers: coerce numeric strings, convert dates to ISO, drop
 * empty strings and FDIC's absence sentinels to absent, and null the ratios FDIC
 * reports as `0` when unreported. `/history` rows become events: each exit's two
 * rows paired into one, classified by role and counterparty, newest first.
 * @module services/fdic/normalize
 */

import { bankClassLabel } from './bank-classes.js';
import { changeCode, type EventType, type HistoryAttribute } from './change-codes.js';
import { failureMethodLabel } from './failure-methods.js';
import { METRIC_CATALOG, type MetricName } from './metric-catalog.js';
import { usDateToIso } from './query-builder.js';
import type {
  BranchRecord,
  FailureRecord,
  FdicRow,
  HistoryEvent,
  HistoryRow,
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

/**
 * A `/history` row with its ID, effective date (`YYYY-MM-DDT00:00:00` upstream),
 * and change code; `undefined` when FDIC sent a row without one of them.
 */
export function historyRow(row: FdicRow): HistoryRow | undefined {
  const d = row.data;
  const id = str(d.ID);
  const effectiveDate = /^\d{4}-\d{2}-\d{2}/.exec(str(d.EFFDATE) ?? '')?.[0];
  const code = num(d.CHANGECODE);
  const changeDescription = str(d.CHANGECODE_DESC);
  if (!id || !effectiveDate || code === null || !changeDescription) return;
  return { id, effectiveDate, changeCode: code, changeDescription, data: d };
}

/** History attributes and the `/history` fields holding their current value. */
const INSTITUTION_ATTRIBUTE_FIELDS: readonly (readonly [HistoryAttribute, string])[] = [
  ['name', 'INSTNAME'],
  ['address', 'PADDR'],
  ['city', 'PCITY'],
  ['state', 'PSTALP'],
  ['bank_class', 'CLASS'],
  ['chartering_agency', 'CHARTAGENT'],
  ['regulator', 'REGAGENT'],
];

const BRANCH_ATTRIBUTE_FIELDS: readonly (readonly [HistoryAttribute, string])[] = [
  ['name', 'OFF_NAME'],
  ['address', 'OFF_PADDR'],
  ['city', 'OFF_PCITY'],
  ['state', 'OFF_PSTALP'],
];

/** `CHANGECODE` of a purchase of branches between institutions. */
const BRANCH_PURCHASE = 712;
/** `CHANGECODE` of a certificate replaced by administrative order. */
const CERT_REPLACED = 150;

/** Each attribute whose former (`FRM_<field>`) and current values are both recorded and differ. */
function changedAttributes(
  d: Record<string, unknown>,
  fields: readonly (readonly [HistoryAttribute, string])[],
): HistoryEvent['changes'] {
  const changes: NonNullable<HistoryEvent['changes']> = {};
  for (const [attribute, field] of fields) {
    const from = str(d[`FRM_${field}`]);
    const to = str(d[field]);
    if (from !== undefined && to !== undefined && from !== to) changes[attribute] = { from, to };
  }
  return Object.keys(changes).length ? changes : undefined;
}

/** The institution a `SUR_`, `OUT_`, `ACQ_`, or `FRM_` field group names. */
function party(d: Record<string, unknown>, prefix: string): HistoryEvent['counterparty'] {
  const cert = positive(d[`${prefix}_CERT`]);
  const name = str(d[`${prefix}_INSTNAME`]);
  return cert === undefined && name === undefined
    ? undefined
    : { ...opt('cert', cert), ...opt('name', name) };
}

/**
 * One row per exit. FDIC records a merger, failure, or assisted takeover twice —
 * an outgoing-side row (211–225) and a survivor-side row (810–812), both carrying
 * the outgoing CERT in `OUT_CERT` — and a CERT's history request returns both.
 * The rows are grouped by `OUT_CERT` and the outgoing-side row is kept: it alone
 * says whether the exit was a failure, and a survivor's 810 row calls a
 * failed-bank takeover an unassisted merger. An exit recorded on one side only
 * keeps that row. Some survivor-side rows (810s from 1979–1991) carry no
 * `OUT_CERT`; one pairs with the outgoing-side row of the same `TRANSNUM` whose
 * `SUR_CERT` names it, and stands alone when no such row was returned.
 */
function oneRowPerExit(rows: readonly HistoryRow[]): HistoryRow[] {
  /** `TRANSNUM:SUR_CERT` of each outgoing-side row → its `OUT_CERT`. */
  const outgoingByTransaction = new Map<string, number>();
  for (const row of rows) {
    const outgoing = positive(row.data.OUT_CERT);
    const transaction = positive(row.data.TRANSNUM);
    const survivor = positive(row.data.SUR_CERT);
    if (
      changeCode(row.changeCode)?.side === 'outgoing' &&
      outgoing !== undefined &&
      transaction !== undefined &&
      survivor !== undefined
    ) {
      outgoingByTransaction.set(`${transaction}:${survivor}`, outgoing);
    }
  }
  const exits = new Map<number, HistoryRow>();
  const rest: HistoryRow[] = [];
  for (const row of rows) {
    const side = changeCode(row.changeCode)?.side;
    const outgoing =
      positive(row.data.OUT_CERT) ??
      (side === 'survivor'
        ? outgoingByTransaction.get(`${positive(row.data.TRANSNUM)}:${positive(row.data.CERT)}`)
        : undefined);
    if (side === undefined || outgoing === undefined) {
      rest.push(row);
      continue;
    }
    const kept = exits.get(outgoing);
    if (!kept || (side === 'outgoing' && changeCode(kept.changeCode)?.side === 'survivor')) {
      exits.set(outgoing, row);
    }
  }
  return [...rest, ...exits.values()];
}

/** An institution-level row as an event of `cert`'s history. */
function institutionEvent(row: HistoryRow, cert: number): HistoryEvent {
  const d = row.data;
  const entry = changeCode(row.changeCode);
  let role: HistoryEvent['role'] = 'subject';
  let counterparty: HistoryEvent['counterparty'];
  if (entry?.side) {
    const outgoing = positive(d.OUT_CERT) === cert;
    role = outgoing ? 'outgoing' : 'survivor';
    counterparty = party(d, outgoing ? 'SUR' : 'OUT');
  } else if (row.changeCode === BRANCH_PURCHASE) {
    const buyer = positive(d.CERT) === cert;
    role = buyer ? 'buyer' : 'seller';
    counterparty = party(d, buyer ? 'OUT' : 'ACQ');
  } else if (row.changeCode === CERT_REPLACED) {
    counterparty = party(d, 'FRM');
  }
  return {
    ...eventBase(row, entry?.eventType ?? 'other', role),
    ...opt('counterparty', counterparty),
    // On every other role the FRM_ fields describe the counterparty, not a prior state.
    ...opt(
      'changes',
      role === 'subject' ? changedAttributes(d, INSTITUTION_ATTRIBUTE_FIELDS) : undefined,
    ),
    ...opt('transaction_number', positive(d.TRANSNUM)),
  };
}

/** A branch-level row: always `branch`, with the office it concerns. */
function branchEvent(row: HistoryRow): HistoryEvent {
  const d = row.data;
  const branch = {
    ...opt('name', str(d.OFF_NAME)),
    ...opt('number', num(d.OFF_NUM) ?? undefined),
    ...opt('address', str(d.OFF_PADDR)),
    ...opt('city', str(d.OFF_PCITY)),
    ...opt('state', str(d.OFF_PSTALP)),
  };
  return {
    ...eventBase(row, 'branch', 'subject'),
    ...opt('changes', changedAttributes(d, BRANCH_ATTRIBUTE_FIELDS)),
    ...opt('branch', Object.keys(branch).length ? branch : undefined),
    ...opt('transaction_number', positive(d.TRANSNUM)),
  };
}

function eventBase(row: HistoryRow, eventType: EventType, role: HistoryEvent['role']) {
  return {
    effective_date: row.effectiveDate,
    event_type: eventType,
    change_code: row.changeCode,
    change_description: row.changeDescription,
    role,
  };
}

/** Newest first: effective date, then transaction number, then row ID, each descending. */
function newestFirst(a: HistoryRow, b: HistoryRow): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1;
  const byTransaction = (num(b.data.TRANSNUM) ?? 0) - (num(a.data.TRANSNUM) ?? 0);
  if (byTransaction !== 0) return byTransaction;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/**
 * `cert`'s history from its institution-level rows (`ORG_ROLE_CDE:FI` matching
 * `CERT`, `OUT_CERT`, or `SUR_CERT`) and branch-level rows, one event per exit,
 * newest first.
 */
export function historyEvents(
  cert: number,
  institutionRows: readonly HistoryRow[],
  branchRows: readonly HistoryRow[],
): HistoryEvent[] {
  const institution = oneRowPerExit(institutionRows).map((row) => ({
    row,
    event: institutionEvent(row, cert),
  }));
  const branch = branchRows.map((row) => ({ row, event: branchEvent(row) }));
  return [...institution, ...branch]
    .sort((a, b) => newestFirst(a.row, b.row))
    .map(({ event }) => event);
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
