/**
 * @fileoverview Tests for the BankFind filter-clause builder: quoting, ranges, place
 * name spellings (case, word joints, St./Saint-style groups), county names and their
 * independent-city forms, name tokenization, and date conversions.
 * @module tests/services/fdic/query-builder.test
 */

import { describe, expect, it } from 'vitest';
import {
  and,
  anyOf,
  CALENDAR_DATE_PATTERN,
  caseVariants,
  containsAllTokens,
  countyName,
  countyVariants,
  eq,
  isCalendarDate,
  isoToRepdte,
  nameTokens,
  normalizeInstitutionName,
  not,
  notExists,
  or,
  quote,
  REPORT_DATE_PATTERN,
  range,
  repdteToIso,
  reportDateToIso,
  titleCase,
  usDateToIso,
} from '@/services/fdic/query-builder.js';
import type { StateCode } from '@/services/fdic/us-states.js';

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

  it('ORs clauses on different fields in parentheses, so they compose under AND; one stands alone', () => {
    expect(and(eq('ORG_ROLE_CDE', 'FI'), or(eq('CERT', 867), eq('OUT_CERT', 867)))).toBe(
      'ORG_ROLE_CDE:"FI" AND (CERT:867 OR OUT_CERT:867)',
    );
    expect(or(eq('CERT', 867))).toBe('CERT:867');
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

  it('capitalizes a letter after an opening parenthesis', () => {
    expect(titleCase('richmond (city)')).toBe('Richmond (City)');
    expect(titleCase('ST. LOUIS (CITY)')).toBe('St. Louis (City)');
  });

  it('sends the value as given plus its title case, deduplicated and whitespace-collapsed', () => {
    expect(caseVariants('n.   platte')).toEqual(['n. platte', 'N. Platte']);
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

  it.each([
    // Word position: leading, mid, trailing.
    ['St. Louis', ['St. Louis', 'St Louis', 'Saint Louis']],
    [
      'Port St. Lucie',
      [
        'Port St. Lucie',
        'Port St Lucie',
        'Port Saint Lucie',
        'Port-St. Lucie',
        'Port-St Lucie',
        'Port-Saint Lucie',
      ],
    ],
    [
      'Rocky Mount',
      ['Rocky Mount', 'Rocky Mt.', 'Rocky Mt', 'Rocky-Mount', 'Rocky-Mt.', 'Rocky-Mt'],
    ],
    // Every group, entered as each kind of member.
    ['Saint Paul', ['Saint Paul', 'St. Paul', 'St Paul', 'Saint-Paul', 'St.-Paul', 'St-Paul']],
    [
      'St Charles',
      ['St Charles', 'St. Charles', 'Saint Charles', 'St-Charles', 'St.-Charles', 'Saint-Charles'],
    ],
    ['Ste. Genevieve', ['Ste. Genevieve', 'Ste Genevieve', 'Sainte Genevieve']],
    [
      'Sainte Genevieve',
      [
        'Sainte Genevieve',
        'Ste. Genevieve',
        'Ste Genevieve',
        'Sainte-Genevieve',
        'Ste.-Genevieve',
        'Ste-Genevieve',
      ],
    ],
    ['Ft Worth', ['Ft Worth', 'Ft. Worth', 'Fort Worth', 'Ft-Worth', 'Ft.-Worth', 'Fort-Worth']],
    ['Mt. Pleasant', ['Mt. Pleasant', 'Mt Pleasant', 'Mount Pleasant']],
    // The word's case carries to its siblings; a title-case form takes the group's spelling.
    ['st. louis', ['st. louis', 'st louis', 'saint louis', 'St. Louis', 'St Louis', 'Saint Louis']],
    [
      'FORT WORTH',
      [
        'FORT WORTH',
        'FT. WORTH',
        'FT WORTH',
        'Fort Worth',
        'Ft. Worth',
        'Ft Worth',
        'Fort-Worth',
        'Ft.-Worth',
        'Ft-Worth',
      ],
    ],
    // Composed with each word-joint spelling.
    [
      "st. mary's",
      [
        "st. mary's",
        "st mary's",
        "saint mary's",
        "St. Mary's",
        "St Mary's",
        "Saint Mary's",
        "St. Mary'S",
        "St Mary'S",
        "Saint Mary'S",
        'St. Mary S',
        'St Mary S',
        'Saint Mary S',
        'St. Marys',
        'St Marys',
        'Saint Marys',
      ],
    ],
  ])('also sends the group word in %j in each other spelling of its group', (value, variants) => {
    expect(caseVariants(value)).toEqual(variants);
  });

  it.each([
    ['Stanton', ['Stanton']],
    ['Stone Mountain', ['Stone Mountain', 'Stone-Mountain']],
    ['Fortuna', ['Fortuna']],
    ['Fairmount', ['Fairmount']],
    // Shaped like a dotted member with a letter for the dot (Ste., St., Mt.).
    ['Stem', ['Stem']],
    ['Sty Hill', ['Sty Hill', 'Sty-Hill']],
    ['Mtn Home', ['Mtn Home', 'Mtn-Home']],
  ])(
    'leaves %j alone: a group spelling inside a longer word is no group word',
    (value, variants) => {
      expect(caseVariants(value)).toEqual(variants);
    },
  );

  it('expands nothing in a value with two group words', () => {
    expect(caseVariants('Fort St. John')).toEqual(['Fort St. John', 'Fort-St. John']);
  });

  it.each([
    ['a non-ASCII letter', 'st. jérôme', ['st. jérôme', 'St. Jérôme']],
    ['a double quote', 'st. "louis"', ['st. "louis"', 'St. "louis"']],
    ['a comma', 'st. louis,', ['st. louis,', 'St. Louis,']],
  ])(
    'expands no group word in a value with %s, a character no FDIC place name with one uses',
    (_label, value, variants) => {
      expect(caseVariants(value)).toEqual(variants);
    },
  );

  it('sends at most 15 spellings for a 50-character city', () => {
    const city = "st. mary's ".padEnd(50, 'x');
    expect(city).toHaveLength(50);
    expect(caseVariants(city)).toHaveLength(15);
  });
});

describe('county names', () => {
  it.each([
    ['King County', 'WA', 'King'],
    ['orleans parish', 'LA', 'orleans'],
    ['Juneau City and Borough', 'AK', 'Juneau'],
    ['Kodiak Island Borough', 'AK', 'Kodiak Island'],
    ['Bethel Census Area', 'AK', 'Bethel'],
    ['Anchorage Municipality', 'AK', 'Anchorage'],
    ['San Juan Municipio', 'PR', 'San Juan'],
    ['Capitol Planning Region', 'CT', 'Capitol'],
    ['  Orleans   Parish ', 'LA', 'Orleans'],
    ['Parish', 'LA', 'Parish'],
    ['Richmond', 'VA', 'Richmond'],
    // County is dropped in any state.
    ['Kodiak Island County', 'AK', 'Kodiak Island'],
    ['Orleans County', 'NY', 'Orleans'],
    // Every other word only in the states whose counties it names (rows above, and
    // Municipality in PR and MP), and kept in a state where it names something else.
    ['Ponce Municipality', 'PR', 'Ponce'],
    ['Saipan Municipality', 'MP', 'Saipan'],
    ['Orleans Parish', 'TX', 'Orleans Parish'],
    ['Juneau City and Borough', 'WA', 'Juneau City and Borough'],
    ['Columbia Borough', 'PA', 'Columbia Borough'],
    ['Bethel Census Area', 'OR', 'Bethel Census Area'],
    ['Monroeville Municipality', 'PA', 'Monroeville Municipality'],
    ['San Juan Municipio', 'FL', 'San Juan Municipio'],
    ['Capitol Planning Region', 'MA', 'Capitol Planning Region'],
  ])('reads county %j in %s as %j', (value, state, name) => {
    expect(countyName(value, state as StateCode)).toBe(name);
  });

  it.each([
    ['Richmond City', 'VA', 'Richmond (City)'],
    ['Richmond (City)', 'VA', 'Richmond (City)'],
    ['richmond (city)', 'VA', 'richmond (City)'],
    ['Carson city', 'NV', 'Carson (City)'],
    ['James City County', 'VA', 'James (City)'],
  ])('reads independent city %j in %s as %j', (value, state, name) => {
    expect(countyName(value, state as StateCode)).toBe(name);
  });

  it('sends a Name (City) county as Name (City) and Name City, each in every spelling', () => {
    expect(countyVariants('Carson (City)')).toEqual([
      'Carson (City)',
      'Carson City',
      'Carson-City',
    ]);
    expect(countyVariants('richmond (City)')).toEqual([
      'richmond (City)',
      'Richmond (City)',
      'richmond City',
      'Richmond City',
      'Richmond-City',
    ]);
  });

  it('strips the suffix before the abbreviation spellings, so Saint Louis City finds St. Louis (City)', () => {
    expect(countyVariants(countyName('Saint Louis City', 'MO' as StateCode))).toEqual([
      'Saint Louis (City)',
      'St. Louis (City)',
      'St Louis (City)',
      'Saint-Louis (City)',
      'St.-Louis (City)',
      'St-Louis (City)',
      'Saint Louis City',
      'St. Louis City',
      'St Louis City',
      'Saint-Louis-City',
      'St.-Louis-City',
      'St-Louis-City',
    ]);
    expect(countyVariants(countyName('Saint Louis County', 'MO' as StateCode))).toEqual([
      'Saint Louis',
      'St. Louis',
      'St Louis',
      'Saint-Louis',
      'St.-Louis',
      'St-Louis',
    ]);
  });

  it('sends a bare county name as that name only, never widened to its independent city', () => {
    expect(countyVariants('Richmond')).toEqual(['Richmond']);
  });

  it('sends at most 30 spellings for a 50-character county', () => {
    const county = `${"st. mary's ".padEnd(45, 'x')} city`;
    expect(county).toHaveLength(50);
    expect(countyVariants(countyName(county, 'WA' as StateCode))).toHaveLength(30);
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
