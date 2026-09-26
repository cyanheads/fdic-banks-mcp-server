/**
 * @fileoverview Failure and assistance resolution methods (`RESTYPE1`), with the
 * resolution type (`RESTYPE`) each code occurs on in live data. Codes follow the
 * live index, which carries `ABT`, `DINB`, and `OBAM` beyond FDIC's published list.
 * @module services/fdic/failure-methods
 */

export const FAILURE_METHOD_CODES = [
  'PA',
  'PI',
  'P&A',
  'IDT',
  'ABT',
  'PO',
  'DINB',
  'A/A',
  'REP',
  'MGR',
  'OBAM',
] as const;

export type FailureMethodCode = (typeof FAILURE_METHOD_CODES)[number];

/** `RESTYPE` values as the live index stores them (uppercase). */
export type ResolutionType = 'FAILURE' | 'ASSISTANCE';

interface FailureMethod {
  label: string;
  /** Present when the code occurs on only one resolution type. */
  resolution?: ResolutionType;
}

export const FAILURE_METHODS: Readonly<Record<FailureMethodCode, FailureMethod>> = {
  PA: { label: 'Purchase and assumption of all deposits', resolution: 'FAILURE' },
  PI: { label: 'Purchase and assumption of insured deposits only', resolution: 'FAILURE' },
  'P&A': {
    label: 'Purchase and assumption, deposit scope undetermined',
    resolution: 'FAILURE',
  },
  IDT: { label: 'Insured deposit transfer', resolution: 'FAILURE' },
  ABT: { label: 'Asset-backed transfer (FSLIC, similar to IDT)', resolution: 'FAILURE' },
  PO: { label: 'Payout', resolution: 'FAILURE' },
  DINB: { label: 'Payout through a Deposit Insurance National Bank', resolution: 'FAILURE' },
  'A/A': { label: 'Assistance transaction', resolution: 'ASSISTANCE' },
  REP: { label: 'Reprivatization' },
  MGR: { label: 'FSLIC management takeover', resolution: 'FAILURE' },
  OBAM: {
    label: 'Undocumented code seen only on assistance rows; FDIC publishes no definition',
    resolution: 'ASSISTANCE',
  },
};

/** Label for a method code; codes outside the table are named as such rather than guessed. */
export function failureMethodLabel(code: string): string {
  return (
    FAILURE_METHODS[code as FailureMethodCode]?.label ??
    `Method code ${code} (not in this server's method table)`
  );
}
