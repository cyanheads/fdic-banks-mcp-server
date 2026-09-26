/**
 * @fileoverview Insurance funds (`SAVR`) that bore the cost of a failure or
 * assistance transaction.
 * @module services/fdic/insurance-funds
 */

export const INSURANCE_FUNDS: Readonly<Record<string, string>> = {
  DIF: 'Deposit Insurance Fund (2006 onward; merged BIF and SAIF)',
  BIF: 'Bank Insurance Fund (1989–2006)',
  SAIF: 'Savings Association Insurance Fund (1989–2006)',
  RTC: 'Resolution Trust Corporation (thrift resolutions, 1989–1995)',
  FSLIC: 'Federal Savings and Loan Insurance Corporation (thrift failures through 1989)',
  FDIC: 'FDIC insurance fund for bank failures before the 1989 split into BIF and SAIF',
};
