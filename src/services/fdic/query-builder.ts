/**
 * @fileoverview Composes BankFind `filters` clauses from typed values — quoting and
 * escaping, case variants for the case-sensitive text fields, and the date formats
 * each dataset stores. Every clause the service sends is built here, so no caller
 * string reaches the query unescaped.
 * @module services/fdic/query-builder
 */

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
  return `!(${eq(field, value)})` as Clause;
}

/** AND of the defined clauses; `undefined` when none. */
export function and(...clauses: (Clause | undefined)[]): Clause | undefined {
  const present = clauses.filter((c): c is Clause => c !== undefined);
  return present.length ? (present.join(' AND ') as Clause) : undefined;
}

// ---------------------------------------------------------------------------
// Case handling
// ---------------------------------------------------------------------------

/** Capitalize the first letter of each space- or hyphen-separated word. */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The value as given (trimmed, whitespace collapsed) and its title-case form,
 * deduplicated. `CITY`, `CITYBR`, and `CNTYNAMB` match exactly and case-sensitively
 * upstream (`Seattle` matches, `seattle` returns zero rows).
 */
export function caseVariants(value: string): string[] {
  const given = value.trim().replace(/\s+/g, ' ');
  return [...new Set([given, titleCase(given)])];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Institution name text for `/institutions` `search`: characters other than
 * letters, digits, spaces, and `& ' . , -` stripped, whitespace collapsed.
 * `undefined` when nothing with a letter or digit remains.
 */
export function normalizeInstitutionName(value: string): string | undefined {
  const cleaned = value
    .replace(/[^\p{L}\p{N}\s&'.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : undefined;
}

/**
 * Failure-name tokens: uppercased, split on anything that is not A–Z or 0–9, and
 * tokens shorter than two characters dropped. Failure names are stored uppercase
 * and `/failures` ignores `search`, so each token becomes a wildcard substring.
 */
export function failureNameTokens(value: string): string[] {
  return value
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length >= 2);
}

/** `NAME:*TOKEN* AND …` over tokens from {@link failureNameTokens}. */
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
