/**
 * @fileoverview Composes BankFind `filters` clauses from typed values — quoting and
 * escaping, the spellings to send for the case-sensitive place-name fields, county
 * names as FDIC records them, and the date formats each dataset stores. Every clause
 * the service sends is built here, so no caller string reaches the query unescaped.
 * @module services/fdic/query-builder
 */

import type { StateCode } from './us-states.js';

declare const clauseBrand: unique symbol;

/** A filter clause produced by this module. Plain strings cannot stand in for one. */
export type Clause = string & { readonly [clauseBrand]: true };

type Scalar = string | number;

/** Double-quote a value, escaping backslashes and quotes. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function term(value: Scalar): string {
  return typeof value === 'number' ? String(value) : quote(value);
}

/** `FIELD:value` — strings quoted, numbers bare. */
export function eq(field: string, value: Scalar): Clause {
  return `${field}:${term(value)}` as Clause;
}

/** `FIELD:(a OR b …)`; a single value collapses to {@link eq}. */
export function anyOf(field: string, values: readonly Scalar[]): Clause {
  if (values.length === 1) return eq(field, values[0] as Scalar);
  return `${field}:(${values.map(term).join(' OR ')})` as Clause;
}

/**
 * `FIELD:[lo TO hi]`, `*` for an open bound. String bounds are validated dates
 * (digits and dashes), sent bare as the range syntax requires.
 */
export function range(
  field: string,
  lo: Scalar | undefined,
  hi: Scalar | undefined,
  options: { upperExclusive?: boolean } = {},
): Clause {
  const close = options.upperExclusive && hi !== undefined ? '}' : ']';
  return `${field}:[${lo ?? '*'} TO ${hi ?? '*'}${close}` as Clause;
}

/** `!(_exists_:FIELD)` — rows where FDIC stores no value. */
export function notExists(field: string): Clause {
  return `!(_exists_:${field})` as Clause;
}

/** `!(FIELD:value)` — rows whose value is anything else. */
export function notEq(field: string, value: Scalar): Clause {
  return not(eq(field, value));
}

/** `!(clause)` — rows the clause does not match. */
export function not(clause: Clause): Clause {
  return `!(${clause})` as Clause;
}

/** AND of the defined clauses; `undefined` when none. */
export function and(...clauses: (Clause | undefined)[]): Clause | undefined {
  const present = clauses.filter((c): c is Clause => c !== undefined);
  return present.length ? (present.join(' AND ') as Clause) : undefined;
}

/** `(a OR b …)`, parenthesized so it composes under {@link and}; one clause stands alone. */
export function or(first: Clause, ...rest: Clause[]): Clause {
  return rest.length ? (`(${[first, ...rest].join(' OR ')})` as Clause) : first;
}

// ---------------------------------------------------------------------------
// Place names
// ---------------------------------------------------------------------------

/**
 * Capitalize the first letter of each space- or hyphen-separated word, and a letter
 * after an opening parenthesis (`Richmond (City)`).
 */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s(-])(\p{L})/gu, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** The spellings FDIC records one place-name word under, each group in a fixed order. */
const WORD_GROUPS: readonly (readonly string[])[] = [
  ['St.', 'St', 'Saint'],
  ['Ste.', 'Ste', 'Sainte'],
  ['Ft.', 'Ft', 'Fort'],
  ['Mt.', 'Mt', 'Mount'],
];

/** Each group member, lowercased, to its group. */
const GROUP_OF = new Map(
  WORD_GROUPS.flatMap((group) => group.map((member) => [member.toLowerCase(), group] as const)),
);

/**
 * A group member as a whole word, in any case: preceded by the start, a space, or a
 * hyphen, and followed by the end, a space, or a hyphen. Literal alternatives inside
 * single-character lookarounds, so the scan is one linear pass.
 */
const GROUP_WORD = new RegExp(
  `(?<![^ -])(?:${[...GROUP_OF.keys()].map((member) => member.replace('.', '\\.')).join('|')})(?![^ -])`,
  'gi',
);

/** A group spelling in the case of the word it stands in for. */
function inCaseOf(word: string, spelling: string): string {
  if (word === word.toLowerCase()) return spelling.toLowerCase();
  if (word === word.toUpperCase()) return spelling.toUpperCase();
  return spelling;
}

/**
 * `form`, then `form` with its group word in each other spelling of the group. A
 * form with no group word, or with more than one, is returned alone.
 */
function groupSpellings(form: string): string[] {
  const [match, ...others] = form.matchAll(GROUP_WORD);
  if (!match || others.length) return [form];
  const word = match[0];
  const group = GROUP_OF.get(word.toLowerCase()) as readonly string[];
  const before = form.slice(0, match.index);
  const after = form.slice(match.index + word.length);
  return [
    form,
    ...group
      .filter((member) => member.toLowerCase() !== word.toLowerCase())
      .map((member) => `${before}${inCaseOf(word, member)}${after}`),
  ];
}

/**
 * The value as given and its title case; for a value with a hyphen or apostrophe,
 * the title case with the letter after an apostrophe capitalized, that form with
 * hyphens and apostrophes as spaces, and the title case with apostrophes dropped;
 * otherwise the title case with each space between two letters as a hyphen. County
 * possessives keep the plain title case (`Prince George's`).
 */
function jointForms(given: string, title: string): string[] {
  if (!/[-']/.test(title)) return [given, title, title.replace(/(?<=\p{L}) (?=\p{L})/gu, '-')];
  const capitalized = title.replace(/'(\p{L})/gu, (_match, ch: string) => `'${ch.toUpperCase()}`);
  return [
    given,
    title,
    capitalized,
    capitalized.replace(/[-']/g, ' ').replace(/\s+/g, ' '),
    title.replace(/'/g, ''),
  ];
}

/**
 * The characters of every FDIC place name that holds a group word. A value with any
 * other character (a non-ASCII letter, a quote, a comma) gets no group spellings:
 * it matches no such name, and with each of those characters percent-encoded to
 * several bytes, tripling its spellings could push a county-and-city request past
 * FDIC's 8 KiB request line.
 */
const GROUP_EXPANDABLE = /^[A-Za-z0-9 .'()-]*$/;

/**
 * The spellings to send for a place name, deduplicated. `CITY`, `CITYBR`, and
 * `CNTYNAMB` match exactly and case-sensitively upstream (`Seattle` matches,
 * `seattle` returns zero rows), and FDIC records some places more than one way:
 * at a word joint (`Winston-Salem` and `Winston Salem`, `Coeur D'Alene` and
 * `Coeur D Alene`, `Lee'S Summit` and `Lees Summit`) and in an abbreviation
 * (`Saint Louis` and `St. Louis`). Sent: the value trimmed and whitespace-collapsed,
 * its title case, and their word-joint spellings; then, for a value of ASCII
 * letters, digits, spaces, and `. ' ( ) -`, each of those holding exactly one
 * whole word from a spelling group (`St.`/`St`/`Saint`, `Ste.`/`Ste`/`Sainte`,
 * `Ft.`/`Ft`/`Fort`, `Mt.`/`Mt`/`Mount`) also with that word as each other member,
 * in the word's case. At most 15 spellings.
 */
export function caseVariants(value: string): string[] {
  const given = value.trim().replace(/\s+/g, ' ');
  const forms = jointForms(given, titleCase(given));
  return [...new Set(GROUP_EXPANDABLE.test(given) ? forms.flatMap(groupSpellings) : forms)];
}

/**
 * A trailing ` County` or one of `words`, as one pattern. The leftmost match wins,
 * so `City and Borough` is stripped whole before `Borough` could be.
 */
const suffixPattern = (words: readonly string[]) =>
  new RegExp(` (?:${['County', ...words].join('|')})$`, 'i');

/** In a state with no county-equivalent words, only ` County` is dropped. */
const COUNTY_ONLY = suffixPattern([]);

/**
 * The county-equivalent words FDIC leaves off `CNTYNAMB`, each dropped only in the
 * states whose counties it names. Elsewhere such a word names another kind of place,
 * so it stays: a Pennsylvania borough is a municipality inside a county, and some
 * share their name with a different county of the state.
 */
const COUNTY_SUFFIX: ReadonlyMap<string, RegExp> = new Map(
  Object.entries({
    AK: ['City and Borough', 'Borough', 'Census Area', 'Municipality'],
    CT: ['Planning Region'],
    LA: ['Parish'],
    MP: ['Municipality'],
    PR: ['Municipality', 'Municipio'],
  }).map(([state, words]) => [state, suffixPattern(words)]),
);

/** A trailing ` City` or ` (City)`: the county is an independent city. */
const CITY_SUFFIX = / (?:city|\(city\))$/i;

/** How FDIC writes the end of an independent city's county name. */
const CITY_FORM = ' (City)';

/**
 * A `county` input in `state` as FDIC names the county: whitespace trimmed and
 * collapsed; one trailing suffix dropped, ` County` in any state and a
 * county-equivalent word only in the states whose counties it names (` Parish` in
 * LA; ` City and Borough`, ` Borough`, ` Census Area`, ` Municipality` in AK;
 * ` Municipality`, ` Municipio` in PR; ` Municipality` in MP; ` Planning Region` in
 * CT), so `Orleans Parish` in LA → `Orleans`; then a trailing ` City` or ` (City)`
 * written ` (City)` (`Richmond City` → `Richmond (City)`), the form FDIC uses for
 * VA, MD, MO, and NV independent cities and for Virginia's Charles City and James
 * City counties.
 */
export function countyName(value: string, state: StateCode): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(COUNTY_SUFFIX.get(state) ?? COUNTY_ONLY, '')
    .replace(CITY_SUFFIX, CITY_FORM);
}

/**
 * The `CNTYNAMB` spellings for a name {@link countyName} returned. A `Name (City)`
 * county is sent as `Name (City)` and `Name City` (FDIC's spelling for some of them
 * through 2022), each through {@link caseVariants}; any other name goes through
 * {@link caseVariants} alone, so a bare name never reaches the independent city of
 * that name. At most 30 spellings.
 */
export function countyVariants(name: string): string[] {
  if (!name.endsWith(CITY_FORM)) return caseVariants(name);
  const base = name.slice(0, -CITY_FORM.length);
  // Disjoint lists: every `Name (City)` spelling ends in `)`, every `Name City` one in `City`.
  return [...caseVariants(`${base}${CITY_FORM}`), ...caseVariants(`${base} City`)];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** A standalone `N.A.` (National Association) in any spelling: `N.A.`, `NA`, `N. A.`. */
const NATIONAL_ASSOCIATION = /(^|[\s,])N\.?\s?A\.?(?=$|[\s,])/giu;

const hasLetterOrDigit = (value: string) => /[\p{L}\p{N}]/u.test(value);

/**
 * Institution name text for `/institutions` `search`: characters other than
 * letters, digits, spaces, and `& ' . , -` stripped, whitespace collapsed, and a
 * standalone `N.A.` dropped — FDIC spells most national banks out as "National
 * Association", and every search word must match, so the abbreviation would miss
 * them. `undefined` when nothing with a letter or digit remains; a name that is
 * nothing but `N.A.` is kept as given.
 */
export function normalizeInstitutionName(value: string): string | undefined {
  const cleaned = value
    .replace(/[^\p{L}\p{N}\s&'.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hasLetterOrDigit(cleaned)) return;
  const withoutNa = cleaned
    .replace(NATIONAL_ASSOCIATION, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
  return hasLetterOrDigit(withoutNa) ? withoutNa : cleaned;
}

/**
 * Name tokens: uppercased, split on anything that is not A–Z or 0–9, tokens
 * shorter than two characters dropped, and a standalone `NA` (National
 * Association) dropped while another token remains — FDIC records it as `N.A.`,
 * which `*NA*` cannot match, so "Park West Bank, NA" would miss "PARK WEST BANK,
 * N.A.". Each becomes a `NAME:*TOKEN*` substring clause — failure names are
 * stored uppercase and `/failures` ignores `search`, and the institution `NAME`
 * filter is an exact, case-insensitive keyword.
 */
export function nameTokens(value: string): string[] {
  const tokens = value
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length >= 2);
  const withoutNa = tokens.filter((token) => token !== 'NA');
  return withoutNa.length ? withoutNa : tokens;
}

/** `NAME:*TOKEN* AND …` over tokens from {@link nameTokens}. */
export function containsAllTokens(field: string, tokens: readonly string[]): Clause | undefined {
  return and(...tokens.map((token) => `${field}:*${token}*` as Clause));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31'] as const;

/** Pattern every `report_date` input matches (quarter-end date, compact date, or quarter label). */
export const REPORT_DATE_PATTERN =
  /^(\d{4}-(03-31|06-30|09-30|12-31)|\d{4}(0331|0630|0930|1231)|\d{4}-?[Qq][1-4])$/;

/** Pattern every calendar-date input matches before the day-of-month check. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A validated `report_date` input as its ISO quarter-end date. */
export function reportDateToIso(value: string): string {
  const label = /^(\d{4})-?[Qq]([1-4])$/.exec(value);
  if (label) return `${label[1]}-${QUARTER_ENDS[Number(label[2]) - 1]}`;
  if (/^\d{8}$/.test(value)) return repdteToIso(value);
  return value;
}

/** True when an ISO `YYYY-MM-DD` names a day its month has. */
export function isCalendarDate(iso: string): boolean {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `2026-06-30` → `20260630`, the only form `REPDTE` (a string field) ranges correctly on. */
export function isoToRepdte(iso: string): string {
  return iso.replace(/-/g, '');
}

/** `20260630` → `2026-06-30`. */
export function repdteToIso(repdte: string): string {
  return `${repdte.slice(0, 4)}-${repdte.slice(4, 6)}-${repdte.slice(6, 8)}`;
}

/**
 * `MM/DD/YYYY` or `M/D/YYYY` (institutions, failures) → ISO. `undefined` for a
 * value that is not a date in that form.
 */
export function usDateToIso(value: string): string | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return;
  const [, month, day, year] = match as unknown as [string, string, string, string];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
