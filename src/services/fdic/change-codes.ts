/**
 * @fileoverview The `/history` structure-change vocabulary: every `CHANGECODE` in the
 * live index with FDIC's own label (`CHANGECODE_DESC`, verbatim, typos included),
 * the event type this server classifies it as, the level it is recorded at
 * (`ORG_ROLE_CDE` FI, BR, or both), and, for the codes that record an exit, which
 * side of the exit the row speaks for. FDIC documents no code list; this one was
 * read from the index by aggregation. The event types, roles, and attribute names
 * the history tool returns live here too, so the tool and fdic_list_reference
 * read one table.
 * @module services/fdic/change-codes
 */

/** Event types, in the order `fdic_get_institution_history` lists them. */
export const EVENT_TYPES = [
  'merger',
  'failure_or_assistance',
  'branch_purchase',
  'name_change',
  'relocation',
  'charter_change',
  'opening',
  'closing',
  'other',
  'branch',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The institution's part in an event. */
export const HISTORY_ROLES = ['subject', 'outgoing', 'survivor', 'buyer', 'seller'] as const;

export type HistoryRole = (typeof HISTORY_ROLES)[number];

/** Attributes a structure change can move from a former value to a new one. */
export const HISTORY_ATTRIBUTES = [
  'name',
  'address',
  'city',
  'state',
  'bank_class',
  'chartering_agency',
  'regulator',
] as const;

export type HistoryAttribute = (typeof HISTORY_ATTRIBUTES)[number];

/** `institution` = `ORG_ROLE_CDE` FI rows only, `branch` = BR only, `both` = either. */
export const CHANGE_CODE_LEVELS = ['institution', 'branch', 'both'] as const;

export type ChangeCodeLevel = (typeof CHANGE_CODE_LEVELS)[number];

export interface ChangeCode {
  code: number;
  /** Event type of an institution-level row; every branch-level row is `branch`. */
  eventType: EventType;
  /** FDIC's `CHANGECODE_DESC`, as the index stores it. */
  label: string;
  level: ChangeCodeLevel;
  /**
   * Codes that record an exit (a merger, failure, or assisted takeover), one row
   * per side: `outgoing` rows speak for the institution that ceased, `survivor`
   * rows (810–812) for the one that absorbed it. Both carry the outgoing CERT in
   * `OUT_CERT`, except some 1979–1991 survivor-side rows that share only `TRANSNUM`.
   */
  side?: 'outgoing' | 'survivor';
}

export const CHANGE_CODES: readonly ChangeCode[] = [
  { code: 1, label: 'History Record Initiation', eventType: 'opening', level: 'institution' },
  { code: 110, label: 'New Institution', eventType: 'opening', level: 'institution' },
  {
    code: 150,
    label: 'Cert Changed from Old Cert by Administrative Order',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 211,
    label: 'Failure - Whole Institution',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 213,
    label: 'Merger - Assisted',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 215,
    label: 'Failure Multiple Acquirer',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 216,
    label: 'Bridge Bank Resolution',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 217,
    label: 'Passthrough Receivorship/Conservatorship Resolution',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 221,
    label: 'Absorbtion - Without Assistance',
    eventType: 'merger',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 222,
    label: 'Consolidated - Without Assistance',
    eventType: 'merger',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 223,
    label: 'Merger -Without Assistance',
    eventType: 'merger',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 224,
    label: 'Affiliated Institution Merger (Pooling) (i.e. Corporate Reorganization',
    eventType: 'merger',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 225,
    label: 'Partial Purchase & Assumption - Without Assistance',
    eventType: 'merger',
    level: 'institution',
    side: 'outgoing',
  },
  {
    code: 230,
    label: 'Closing - Failure Payoff',
    eventType: 'failure_or_assistance',
    level: 'institution',
  },
  {
    code: 235,
    label: 'Rtc Supervised Payoffs, Liquidations, and Closings',
    eventType: 'failure_or_assistance',
    level: 'institution',
  },
  { code: 240, label: 'Closing - Voluntary', eventType: 'closing', level: 'institution' },
  {
    code: 260,
    label: 'Bank Closed by Chartering Agency Pending Sale',
    eventType: 'closing',
    level: 'institution',
  },
  {
    code: 310,
    label: 'Institution Becomes a Member of FRS (Federal Reserve System)',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 320,
    label: 'Institution Withdraws from FRS (Federal Reserve System)',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 340,
    label: 'Institution Withdraws from FHS',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 350,
    label: 'Institution Enters Conservatorship',
    eventType: 'failure_or_assistance',
    level: 'institution',
  },
  {
    code: 360,
    label: 'Conservatorship Institution Resolved',
    eventType: 'failure_or_assistance',
    level: 'institution',
  },
  {
    code: 410,
    label: 'Change in Insurance Status - ONI Becomes Insured',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 420,
    label: 'Change in Chartering Agency',
    eventType: 'charter_change',
    level: 'institution',
  },
  { code: 430, label: 'Change in Class', eventType: 'charter_change', level: 'institution' },
  {
    code: 440,
    label: 'Change in Organization Type',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 470,
    label: 'Change in Primary Regulatory Agency',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 510,
    label: 'Change in Legal Name (FO or BR)',
    eventType: 'name_change',
    level: 'institution',
  },
  {
    code: 520,
    label: 'Change in Physical Location (FO or BR)',
    eventType: 'relocation',
    level: 'both',
  },
  { code: 610, label: 'Trust Powers Granted', eventType: 'charter_change', level: 'institution' },
  { code: 711, label: 'Branch Opening', eventType: 'branch', level: 'branch' },
  { code: 712, label: 'Branch Purchased', eventType: 'branch_purchase', level: 'both' },
  {
    code: 713,
    label: 'Branch Acquired in Merger/Consolidation/Failure',
    eventType: 'branch',
    level: 'branch',
  },
  { code: 721, label: 'Branch Closing', eventType: 'branch', level: 'branch' },
  { code: 722, label: 'Branch Sold', eventType: 'branch', level: 'branch' },
  {
    code: 724,
    label: 'Branches Divested in Multiple Acquirer Failure',
    eventType: 'branch',
    level: 'branch',
  },
  {
    code: 810,
    label: 'Participated in Absorbtion/Consolidation/Merger',
    eventType: 'merger',
    level: 'institution',
    side: 'survivor',
  },
  {
    code: 811,
    label: 'Participated in FDIC Assisted Merger',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'survivor',
  },
  {
    code: 812,
    label: 'Rtc Assisted Merger',
    eventType: 'failure_or_assistance',
    level: 'institution',
    side: 'survivor',
  },
  {
    code: 820,
    label: 'Phantom (Interim) Corporate Reorganization',
    eventType: 'charter_change',
    level: 'institution',
  },
  {
    code: 830,
    label: 'Open Bank Assistance',
    eventType: 'failure_or_assistance',
    level: 'institution',
  },
];

const BY_CODE = new Map(CHANGE_CODES.map((entry) => [entry.code, entry]));

/** The table entry for a code; `undefined` for a code the index has added since. */
export function changeCode(code: number): ChangeCode | undefined {
  return BY_CODE.get(code);
}
