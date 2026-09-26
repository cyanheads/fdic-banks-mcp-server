/**
 * @fileoverview Tests for the BankFind filter-clause builder: quoting, ranges, case
 * variants, name tokenization, and date conversions.
 * @module tests/services/fdic/query-builder.test
 */

import { describe, expect, it } from 'vitest';
import {
  and,
  anyOf,
  CALENDAR_DATE_PATTERN,
  caseVariants,
  containsAllTokens,
  eq,
  isCalendarDate,
  isoToRepdte,
  nameTokens,
  normalizeInstitutionName,
  not,
  notExists,
  quote,
  REPORT_DATE_PATTERN,
  range,
  repdteToIso,
  reportDateToIso,
  titleCase,
  usDateToIso,
} from '@/services/fdic/query-builder.js';

describe('clauses', () => {
  it('quotes strings with backslashes and quotes escaped, leaves numbers bare', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(eq('STALP', 'WA')).toBe('STALP:"WA"');
    expect(eq('CERT', 3510)).toBe('CERT:3510');
  });

  it('builds OR lists and collapses a single value to eq', () => {
    expect(anyOf('CERT', [1, 2, 3])).toBe('CERT:(1 OR 2 OR 3)');
    expect(anyOf('BKCLASS', ['N'])).toBe('BKCLASS:"N"');
    expect(anyOf('RESTYPE1', ['PA', 'P&A', 'A/A'])).toBe('RESTYPE1:("PA" OR "P&A" OR "A/A")');
  });

  it('builds closed, open, and upper-exclusive ranges; 0 is a bound, not an open end', () => {
    expect(range('ASSET', 0, 100)).toBe('ASSET:[0 TO 100]');
    expect(range('FAILDATE', '2023-01-01', undefined)).toBe('FAILDATE:[2023-01-01 TO *]');
    expect(range('FAILDATE', undefined, '2023-12-31')).toBe('FAILDATE:[* TO 2023-12-31]');
    expect(range('ASSET', 1_000_000, 10_000_000, { upperExclusive: true })).toBe(
      'ASSET:[1000000 TO 10000000}',
    );
    // An open upper end stays inclusive: `*}` is not valid syntax.
    expect(range('ASSET', 250_000_000, undefined, { upperExclusive: true })).toBe(
      'ASSET:[250000000 TO *]',
    );
  });

  it('ANDs only the defined clauses and yields undefined for none', () => {
    expect(and(eq('CERT', 1), undefined, notExists('COST'))).toBe('CERT:1 AND !(_exists_:COST)');
    expect(and(undefined, undefined)).toBeUndefined();
  });

  it('negates a whole clause, compound or not', () => {
    expect(not(eq('ACTIVE', 1))).toBe('!(ACTIVE:1)');
    expect(not(and(eq('ACTIVE', 1), containsAllTokens('NAME', ['HARBOR']))!)).toBe(
      '!(ACTIVE:1 AND NAME:*HARBOR*)',
    );
  });
});

describe('case handling', () => {
  it('title-cases words split on spaces and hyphens', () => {
    expect(titleCase('ST. LOUIS')).toBe('St. Louis');
    expect(titleCase('winston-salem')).toBe('Winston-Salem');
  });

  it('sends the value as given plus its title case, deduplicated and whitespace-collapsed', () => {
    expect(caseVariants('st.   louis')).toEqual(['st. louis', 'St. Louis']);
    expect(caseVariants('  Seattle ')).toEqual(['Seattle']);
  });

  it.each([
    ['Winston-Salem', ['Winston-Salem', 'Winston Salem']],
    ['winston salem', ['winston salem', 'Winston Salem', 'Winston-Salem']],
    ['Walla Walla', ['Walla Walla', 'Walla-Walla']],
    [
      "coeur d'alene",
      ["coeur d'alene", "Coeur D'alene", "Coeur D'Alene", 'Coeur D Alene', 'Coeur Dalene'],
    ],
    [
      "lee's summit",
      ["lee's summit", "Lee's Summit", "Lee'S Summit", 'Lee S Summit', 'Lees Summit'],
    ],
    [
      "Prince George's",
      ["Prince George's", "Prince George'S", 'Prince George S', 'Prince Georges'],
    ],
    ["Land O' Lakes", ["Land O' Lakes", 'Land O Lakes']],
  ])('adds the spellings FDIC records a place under for %j', (value, variants) => {
    expect(caseVariants(value)).toEqual(variants);
  });
});

describe('names', () => {
  it("strips characters outside letters, digits, spaces, and & ' . , - from institution names", () => {
    expect(normalizeInstitutionName('Evergreen <Harbor> "Bank"; OR *')).toBe(
      'Evergreen Harbor Bank OR',
    );
    expect(normalizeInstitutionName("Farmers & Merchants' Bank")).toBe("Farmers & Merchants' Bank");
    expect(normalizeInstitutionName('Banco Popular de Puerto Rico')).toBe(
      'Banco Popular de Puerto Rico',
    );
  });

  it.each([
    ['Wells Fargo Bank, N.A.', 'Wells Fargo Bank'],
    ["Farmers & Merchants' Bank, N.A.", "Farmers & Merchants' Bank"],
    ['Bank of America NA', 'Bank of America'],
    ['citibank n.a', 'citibank'],
    ['American Bank of Texas, N. A. - Fredericksburg', 'American Bank of Texas, - Fredericksburg'],
    ['First Bank,NA', 'First Bank'],
    ['NA Bank NA', 'Bank'],
  ])(
    'drops a standalone N.A. from %j, since FDIC mostly spells out National Association',
    (value, expected) => {
      expect(normalizeInstitutionName(value)).toBe(expected);
    },
  );

  it('keeps NA inside a word, the spelled-out form, and a name that is nothing but N.A.', () => {
    expect(normalizeInstitutionName('Banana Bank')).toBe('Banana Bank');
    expect(normalizeInstitutionName('NAB Bank')).toBe('NAB Bank');
    expect(normalizeInstitutionName('Bank, National Association')).toBe(
      'Bank, National Association',
    );
    expect(normalizeInstitutionName('N.A.')).toBe('N.A.');
  });

  it('returns undefined when no letter or digit survives', () => {
    expect(normalizeInstitutionName('*** ""')).toBeUndefined();
    expect(normalizeInstitutionName('& - .')).toBeUndefined();
  });

  it('tokenizes names uppercase, dropping one-character tokens', () => {
    expect(nameTokens("First Republic Bank's")).toEqual(['FIRST', 'REPUBLIC', 'BANK']);
    expect(nameTokens('a b !')).toEqual([]);
    expect(containsAllTokens('NAME', ['SILICON', 'VALLEY'])).toBe(
      'NAME:*SILICON* AND NAME:*VALLEY*',
    );
  });

  it.each([
    ['Park West Bank, NA', ['PARK', 'WEST', 'BANK']],
    ['park west bank na', ['PARK', 'WEST', 'BANK']],
    ['NA Bank', ['BANK']],
    ['Park West Bank, N.A.', ['PARK', 'WEST', 'BANK']],
    ['Park West Bank, N. A.', ['PARK', 'WEST', 'BANK']],
  ])(
    'drops a standalone NA from %j when another token remains, so it also matches N.A.',
    (value, tokens) => {
      expect(nameTokens(value)).toEqual(tokens);
    },
  );

  it('keeps NA when it is the only token, and NA inside a word', () => {
    expect(nameTokens('NA')).toEqual(['NA']);
    expect(nameTokens('N.A. NA')).toEqual(['NA']);
    expect(nameTokens('National Bank')).toEqual(['NATIONAL', 'BANK']);
    expect(nameTokens('Banner Bank')).toEqual(['BANNER', 'BANK']);
  });
});

describe('dates', () => {
  it.each([
    ['2026-06-30', '2026-06-30'],
    ['20260630', '2026-06-30'],
    ['2026Q2', '2026-06-30'],
    ['2026-q1', '2026-03-31'],
    ['1984Q4', '1984-12-31'],
  ])('maps report_date %s to %s', (input, iso) => {
    expect(REPORT_DATE_PATTERN.test(input)).toBe(true);
    expect(reportDateToIso(input)).toBe(iso);
  });

  it.each(['2026-06-15', '20260615', '2026Q5', '2026Q0', '26Q2', '2026-6-30'])(
    'rejects report_date %s',
    (input) => {
      expect(REPORT_DATE_PATTERN.test(input)).toBe(false);
    },
  );

  it('checks calendar dates against the month length, leap years included', () => {
    expect(CALENDAR_DATE_PATTERN.test('2023-02-30')).toBe(true);
    expect(isCalendarDate('2023-02-30')).toBe(false);
    expect(isCalendarDate('2023-04-31')).toBe(false);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(CALENDAR_DATE_PATTERN.test('2023-13-01')).toBe(false);
    expect(CALENDAR_DATE_PATTERN.test('2023-2-1')).toBe(false);
  });

  it('converts between ISO, REPDTE, and US date forms', () => {
    expect(isoToRepdte('2026-06-30')).toBe('20260630');
    expect(repdteToIso('20260630')).toBe('2026-06-30');
    expect(usDateToIso('3/10/2023')).toBe('2023-03-10');
    expect(usDateToIso('12/31/9999')).toBe('9999-12-31');
    expect(usDateToIso('2023-03-10')).toBeUndefined();
  });
});
