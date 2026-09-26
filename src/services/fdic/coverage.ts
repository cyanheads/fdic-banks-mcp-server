/**
 * @fileoverview Coverage window and cadence of each BankFind dataset this server reads.
 * @module services/fdic/coverage
 */

interface DatasetCoverage {
  cadence: string;
  code: string;
  label: string;
  lag?: string;
  starts: string;
}

export const COVERAGE: readonly DatasetCoverage[] = [
  {
    code: 'financials',
    label: 'Quarterly Call Report financials',
    starts: '1984Q1 (1984-03-31)',
    cadence: 'quarterly, as of each quarter end',
    lag: 'about seven weeks after quarter end',
  },
  {
    code: 'summary_of_deposits',
    label: 'Summary of Deposits: branch-level domestic deposits',
    starts: '1994',
    cadence: 'annual, as of June 30',
    lag: 'about three months after June 30',
  },
  {
    code: 'failures',
    label: 'Bank failures and assistance transactions',
    starts: '1934',
    cadence: 'one record per event',
  },
  {
    code: 'institutions',
    label: 'Institution structure and status: every FDIC-insured charter, active and inactive',
    starts: '1934',
    cadence: 'one current record per charter; inactive charters keep their last reported state',
  },
];
