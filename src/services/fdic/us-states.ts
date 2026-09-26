/**
 * @fileoverview US state, DC, and territory postal codes with full names, and the
 * normalizer every `state` input runs through. FDIC state filters return zero rows
 * for a lowercase code rather than erroring, so this normalization is load-bearing.
 * @module services/fdic/us-states
 */

export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'U.S. Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

/** Lowercase, drop periods and commas, collapse whitespace. */
function nameKey(value: string): string {
  return value.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

const BY_NAME = new Map<string, string>([
  ...Object.entries(US_STATES).map(([code, name]) => [nameKey(name), code] as [string, string]),
  ['virgin islands', 'VI'],
  ['washington dc', 'DC'],
]);

declare const stateCodeBrand: unique symbol;

/** An uppercase postal code from {@link normalizeState} — the only form FDIC state filters match. */
export type StateCode = string & { readonly [stateCodeBrand]: true };

/**
 * A two-letter code in any case, or a full name, as the uppercase postal code.
 * `undefined` when the value names no state, DC, or territory.
 */
export function normalizeState(value: string): StateCode | undefined {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && upper in US_STATES) return upper as StateCode;
  return BY_NAME.get(nameKey(trimmed)) as StateCode | undefined;
}
