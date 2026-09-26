/**
 * @fileoverview FDIC institution charter classes (`BKCLASS`) and their labels.
 * @module services/fdic/bank-classes
 */

export const BANK_CLASS_CODES = ['N', 'NM', 'SM', 'SB', 'SI', 'SL', 'OI', 'NC'] as const;

export type BankClassCode = (typeof BANK_CLASS_CODES)[number];

export const BANK_CLASSES: Readonly<Record<BankClassCode, string>> = {
  N: 'National bank (OCC-chartered, Federal Reserve member)',
  NM: 'State-chartered bank, not a Federal Reserve member',
  SM: 'State-chartered bank, Federal Reserve member',
  SB: 'Federal savings bank',
  SI: 'State-chartered savings bank',
  SL: 'State-chartered savings and loan association',
  OI: 'Insured U.S. branch of a foreign bank',
  NC: 'Noninsured non-deposit trust company',
};

/** Label for a class code; codes outside the table are named as such rather than guessed. */
export function bankClassLabel(code: string): string {
  return (
    BANK_CLASSES[code as BankClassCode] ?? `Class code ${code} (not in this server's class table)`
  );
}
