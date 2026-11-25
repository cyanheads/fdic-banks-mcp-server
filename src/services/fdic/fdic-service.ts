/**
 * @fileoverview Client for the FDIC BankFind Suite API (`https://api.fdic.gov/banks`).
 * One pipeline per request — cache → in-flight dedupe → retry (outside) → pacer
 * (inside) → transport → JSON parse → envelope check — plus typed query methods
 * that own the upstream's traps: case-sensitive codes, `REPDTE` as a string field,
 * `sort_by` honored only beside `sort_order`, absence sentinels, and fields FDIC
 * reports as `0` when unreported.
 * @module services/fdic/fdic-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  fetchWithTimeout,
  type Pacer,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { BankClassCode } from './bank-classes.js';
import type { EventType } from './change-codes.js';
import { METRIC_CATALOG, type MetricName } from './metric-catalog.js';
import {
  historyEvents,
  historyRow,
  metricValues,
  normalizeBranch,
  normalizeFailure,
  normalizeInstitution,
  num,
  str,
} from './normalize.js';
import {
  and,
  anyOf,
  type Clause,
  caseVariants,
  containsAllTokens,
  countyVariants,
  eq,
  isoToRepdte,
  nameTokens,
  not,
  notEq,
  notExists,
  or,
  range,
  repdteToIso,
  usDateToIso,
} from './query-builder.js';
import type {
  BranchRecord,
  CallBudget,
  FailureAggregation,
  FailureBucket,
  FailureFilters,
  FailureGroupBy,
  FailureRecord,
  FailureSort,
  FailureTotals,
  FdicEnvelope,
  FdicRow,
  FinancialRow,
  HistoryEvent,
  HistoryRow,
  InstitutionRecord,
  InstitutionStatus,
  MetricValues,
  PanelFilters,
  PanelQuarter,
  PanelRow,
  SodBucket,
  SodGeography,
} from './types.js';
import type { StateCode } from './us-states.js';

const BASE_URL = 'https://api.fdic.gov/banks';

/** Per-request transport timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Longest a call waits in the pacer queue before it is shed. */
const MAX_QUEUE_WAIT_MS = 15_000;
/** Wall-clock budget of one tool call, so the classified error lands inside a client's 60 s timeout. */
const TOOL_BUDGET_MS = 45_000;
/** Budget of the multi-quarter panel fetch, the one long-running call. */
export const PANEL_BUDGET_MS = 55_000;
/** Largest page BankFind serves; also the aggregation bucket cap (`agg_limit`) and the chunk a relevance search is read in. */
const MAX_PAGE = 10_000;
/** Panel runs fetched concurrently (the pacer still bounds requests in flight). */
const PANEL_RUN_CONCURRENCY = 3;
/** Cooldown the pacer applies after a 429; also the wait reported when FDIC names none. */
const COOLDOWN_BASE_MS = 5_000;

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * Reads of a relevance chunk, beyond the first, while it disagrees with its
 * recorded order. FDIC picks one of its two orders per request (7 and 5 of 12
 * repeated reads), so a chunk still disagrees after 6 more reads about 1 time in 64.
 */
const MAX_ORDER_REREADS = 6;
/** Bound of the relevance order record: about 200 full chunks, each 40 KB, against the cache's 14. */
const MAX_ORDER_BYTES = 8 * 1024 * 1024;

type Endpoint = 'institutions' | 'financials' | 'failures' | 'sod' | 'history';
type Params = Record<string, string | number | undefined>;

/** Transport seam: fetch one URL and return its parsed JSON body. */
export type GetJson = (
  url: URL,
  opts: { context: RequestContext; signal: AbortSignal; timeoutMs: number },
) => Promise<unknown>;

export interface FdicServiceOptions {
  cacheTtlSeconds?: number;
  getJson?: GetJson;
  now?: () => number;
  pacer?: Pacer;
}

/** A call budget starting now. */
export function callBudget(ms: number = TOOL_BUDGET_MS): CallBudget {
  return { deadlineAt: Date.now() + ms };
}

/** Default transport: `fetchWithTimeout` + JSON parse, with a 200-carrying-HTML guard. */
export function createFetchJson(userAgent: string): GetJson {
  return async (url, { signal, timeoutMs, context }) => {
    const response = await fetchWithTimeout(url, timeoutMs, context, {
      signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      errorBodyLimit: 2000,
    });
    const text = await response.text();
    if (/^\s*</.test(text)) {
      throw serviceUnavailable('FDIC returned HTML instead of JSON; its API gateway is degraded.', {
        status: response.status,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw serviceUnavailable(
        'FDIC returned a body that is not valid JSON.',
        { status: response.status },
        { cause: err },
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  bytes: number;
  expiresAt: number;
  value: FdicEnvelope;
}

/** LRU over successful envelopes, bounded by approximate response size. */
class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): FdicEnvelope | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.totalBytes -= entry.bytes;
      return;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: FdicEnvelope): void {
    if (this.ttlMs <= 0) return;
    const bytes = JSON.stringify(value).length;
    if (bytes > MAX_ENTRY_BYTES) return;
    this.delete(key);
    this.entries.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
    this.totalBytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.totalBytes <= MAX_CACHE_BYTES) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}

// ---------------------------------------------------------------------------
// Relevance chunk orders
// ---------------------------------------------------------------------------

/**
 * Heap of one tier record besides its key (counted at 2 bytes a character): the
 * object, its chunk map, and its LRU slot. Measured on Node 26 and Bun 1.4, a record
 * with an 89-character key and one empty chunk holds 560–630 bytes.
 */
const TIER_RECORD_BYTES = 400;
/** Heap of one recorded chunk besides its 4 bytes a CERT (measured 64–200 bytes): the typed array and its map slot. */
const CHUNK_RECORD_BYTES = 200;

/** The chunk orders of one relevance tier, all from one FDIC index build. */
interface TierOrder {
  bytes: number;
  /** Chunk index → its CERTs, in the order the chunk was served. */
  chunks: Map<number, Int32Array>;
  dataAsOf: string;
}

/** How a chunk read lines up with the order its tier was served in. */
type Alignment =
  /** The read holds the chunk's recorded CERTs, or shares none with the tier's other chunks: `rows` is it in the served order. */
  | { kind: 'aligned'; rows: FdicRow[] }
  /** The read comes from a newer FDIC index build than the record, so there is nothing to compare it with. */
  | { kind: 'rebuilt' }
  /** A different CERT set, a CERT another chunk of the tier holds, or an older index build. */
  | { kind: 'disagrees' };

const certOf = (row: FdicRow): number => num(row.data.CERT) ?? 0;

function sameOrder(certs: Int32Array, rows: readonly FdicRow[]): boolean {
  return certs.length === rows.length && rows.every((row, i) => certOf(row) === certs[i]);
}

/**
 * The CERT order each relevance chunk was served in, per tier (`search` and
 * `filters`), kept past the chunk's cache entry so a later read of the chunk — after
 * expiry, eviction, or with the cache off — can be checked against what earlier
 * pages were cut from. LRU by tier, bounded by bytes.
 */
class ChunkOrders {
  private readonly tiers = new Map<string, TierOrder>();
  private totalBytes = 0;

  align(tier: string, index: number, read: FdicEnvelope): Alignment {
    const entry = this.tiers.get(tier);
    if (!entry) return { kind: 'aligned', rows: read.rows };
    if (read.dataAsOf > entry.dataAsOf) return { kind: 'rebuilt' };
    if (read.dataAsOf < entry.dataAsOf) return { kind: 'disagrees' };
    const own = entry.chunks.get(index);
    if (own) {
      if (sameOrder(own, read.rows)) return { kind: 'aligned', rows: read.rows };
      const byCert = new Map(read.rows.map((row) => [certOf(row), row]));
      if (byCert.size !== own.length || read.rows.length !== own.length) {
        return { kind: 'disagrees' };
      }
      const rows: FdicRow[] = [];
      for (const cert of own) {
        const row = byCert.get(cert);
        if (!row) return { kind: 'disagrees' };
        rows.push(row);
      }
      return { kind: 'aligned', rows };
    }
    const certs = new Set(read.rows.map(certOf));
    for (const [other, recorded] of entry.chunks) {
      if (other !== index && recorded.some((cert) => certs.has(cert))) return { kind: 'disagrees' };
    }
    return { kind: 'aligned', rows: read.rows };
  }

  /**
   * Records `read` as the chunk's served order. A read from a newer index build
   * replaces the tier's record; one from an older build is ignored.
   */
  record(tier: string, index: number, read: FdicEnvelope): void {
    let entry = this.tiers.get(tier);
    if (entry && read.dataAsOf < entry.dataAsOf) return;
    if (entry && read.dataAsOf > entry.dataAsOf) {
      this.drop(tier);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        dataAsOf: read.dataAsOf,
        chunks: new Map(),
        bytes: TIER_RECORD_BYTES + 2 * tier.length,
      };
      this.totalBytes += entry.bytes;
    }
    this.tiers.delete(tier);
    this.tiers.set(tier, entry);
    const previous = entry.chunks.get(index);
    if (previous && sameOrder(previous, read.rows)) return;
    const certs = Int32Array.from(read.rows, certOf);
    const bytes = certs.byteLength + (previous ? -previous.byteLength : CHUNK_RECORD_BYTES);
    entry.chunks.set(index, certs);
    entry.bytes += bytes;
    this.totalBytes += bytes;
    for (const oldest of this.tiers.keys()) {
      if (this.totalBytes <= MAX_ORDER_BYTES) break;
      this.drop(oldest);
    }
  }

  private drop(tier: string): void {
    const entry = this.tiers.get(tier);
    if (!entry) return;
    this.tiers.delete(tier);
    this.totalBytes -= entry.bytes;
  }
}

// ---------------------------------------------------------------------------
// Envelope and error handling
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * FDIC's 400 envelope → `{ detail, parameter }`, from a parsed body or captured body
 * text. Text that is not JSON (a gateway page) yields nothing: it is not FDIC's
 * message, and a raw upstream body never reaches the caller.
 */
function badRequestDetail(body: unknown): { detail?: string; parameter?: string } {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return {};
    }
  }
  const first = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
  if (!isRecord(first)) return {};
  const detail = str(first.detail) ?? str(first.title);
  const parameter = isRecord(first.source) ? str(first.source.parameter) : undefined;
  return { ...(detail ? { detail } : {}), ...(parameter ? { parameter } : {}) };
}

/**
 * A 400 means this server built a query FDIC rejected: every query is composed
 * from validated input, so it is reported as this server's fault, never the caller's.
 */
function queryRejected(body: unknown, cause?: unknown): McpError {
  const { detail, parameter } = badRequestDetail(body);
  return internalError(
    `FDIC rejected a query this server built${detail ? `: ${detail}` : '.'}`,
    { status: 400, ...(detail ? { detail } : {}), ...(parameter ? { parameter } : {}) },
    cause === undefined ? undefined : { cause },
  );
}

/** Validates the BankFind envelope; an error envelope or unexpected shape throws. */
function parseEnvelope(body: unknown): FdicEnvelope {
  if (isRecord(body) && Array.isArray(body.errors)) throw queryRejected(body);
  const meta = isRecord(body) ? body.meta : undefined;
  const index = isRecord(meta) ? meta.index : undefined;
  const total = isRecord(meta) ? num(meta.total) : null;
  const dataAsOf = isRecord(index) ? str(index.createTimestamp) : undefined;
  if (!isRecord(body) || !Array.isArray(body.data) || total === null || !dataAsOf) {
    throw serviceUnavailable('FDIC returned a response without the expected meta and data blocks.');
  }
  return {
    total,
    dataAsOf,
    rows: body.data.filter(isRecord).map((row) => ({
      data: isRecord(row.data) ? row.data : {},
      ...(isRecord(row.highlight) ? { highlight: row.highlight } : {}),
    })),
    totals: isRecord(body.totals) ? body.totals : {},
  };
}

/** `Retry-After` as whole seconds when FDIC sent the delta-seconds form. */
function retryAfterSeconds(value: unknown): number | undefined {
  const n = num(value);
  return n !== null && n >= 0 ? Math.ceil(n) : undefined;
}

/**
 * The calling tool's recovery for a rate-limit reason with the wait filled in: the
 * contract text says `retryAfter seconds`, which names the number only in
 * `data.retryAfter`, out of reach of a client that reads `content[]` alone. With no
 * wait to name, nothing is set and the framework fills in the contract text as is.
 */
function waitRecovery(
  reason: 'pacer_shed' | 'upstream_rate_limited',
  seconds: number | undefined,
  ctx: Context,
) {
  const resolved = ctx.recoveryFor(reason);
  if (seconds === undefined || !('recovery' in resolved)) return {};
  const wait = `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  return { recovery: { hint: resolved.recovery.hint.replace('retryAfter seconds', wait) } };
}

/**
 * Rewraps the two rate-limit shapes under the reasons every data tool declares,
 * with the calling tool's recovery text naming the wait, and a 400 as this
 * server's fault. Any other HTTP failure keeps its code and message, but its
 * `data` — which reaches the caller as `structuredContent.error.data` — is cut to
 * the status fields; the captured upstream body stays on the cause, for logs only.
 */
function mapFailure(err: unknown, ctx: Context): unknown {
  if (!(err instanceof McpError)) return err;
  const data = isRecord(err.data) ? err.data : {};
  if (err.code === JsonRpcErrorCode.RateLimited) {
    if (data.reason === 'pacer_shed') {
      return rateLimited(
        err.message,
        {
          ...data,
          reason: 'pacer_shed',
          retryable: true,
          ...waitRecovery('pacer_shed', retryAfterSeconds(data.retryAfter), ctx),
        },
        { cause: err },
      );
    }
    const retryAfter = retryAfterSeconds(data.retryAfter) ?? COOLDOWN_BASE_MS / 1000;
    return rateLimited(
      'FDIC is throttling requests (HTTP 429) and retries were exhausted.',
      {
        reason: 'upstream_rate_limited',
        retryAfter,
        retryable: true,
        ...waitRecovery('upstream_rate_limited', retryAfter, ctx),
      },
      { cause: err },
    );
  }
  if (err.code === JsonRpcErrorCode.InvalidParams) {
    return queryRejected(data.body ?? data.responseBody ?? data, err);
  }
  if (data.errorSource === 'FetchHttpError') {
    const { status, statusText, retryAfter, retryable } = data;
    return new McpError(
      err.code,
      err.message,
      {
        status,
        statusText,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
      },
      { cause: err },
    );
  }
  return err;
}

/** Canonical URL: params sorted, undefined dropped, values percent-encoded. */
function buildUrl(endpoint: Endpoint, params: Params): URL {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
  return new URL(`${BASE_URL}/${endpoint}?${query}`);
}

// ---------------------------------------------------------------------------
// Query inputs
// ---------------------------------------------------------------------------

export interface InstitutionSearch {
  bankClasses?: readonly BankClassCode[];
  certs?: readonly number[];
  city?: string;
  holdingCompanyRssd?: number;
  limit: number;
  maxAssets?: number;
  minAssets?: number;
  /** Normalized name text (see `normalizeInstitutionName`). */
  name?: string;
  offset: number;
  sort: 'relevance' | 'assets_desc' | 'name';
  state?: StateCode;
  status: InstitutionStatus;
}

/** One page of an institution search. */
export interface InstitutionPage {
  dataAsOf: string;
  /**
   * A relevance page past offset 0 cut from a chunk whose order could not be matched
   * to the one earlier pages of the search were cut from (its re-reads ran out or
   * failed, or FDIC rebuilt its index), so it can repeat or skip one of their matches.
   */
  orderUnconfirmed: boolean;
  rows: InstitutionRecord[];
  total: number;
}

const INSTITUTION_FIELDS = [
  'CERT',
  'NAME',
  'ACTIVE',
  'CITY',
  'STALP',
  'COUNTY',
  'BKCLASS',
  'REGAGNT',
  'ESTYMD',
  'INSDATE',
  'ENDEFYMD',
  'NEWCERT',
  'NAMEHCR',
  'RSSDHCR',
  'FED_RSSD',
  'ASSET',
  'DEP',
  'OFFDOM',
  'REPDTE',
].join(',');

const FAILURE_FIELDS = [
  'ID',
  'CERT',
  'FIN',
  'NAME',
  'CITY',
  'PSTALP',
  'FAILDATE',
  'RESDATE',
  'RESTYPE',
  'RESTYPE1',
  'SAVR',
  'CHCLASS1',
  'QBFASSET',
  'QBFDEP',
  'COST',
  'COSTMOSTRECENTASOF',
  'BIDNAME',
  'BIDCITY',
  'BIDSTATE',
].join(',');

const FAILURE_SORT: Record<FailureSort, { field: string; order: 'ASC' | 'DESC' }> = {
  date_desc: { field: 'FAILDATE', order: 'DESC' },
  date_asc: { field: 'FAILDATE', order: 'ASC' },
  loss_desc: { field: 'COST', order: 'DESC' },
  assets_desc: { field: 'QBFASSET', order: 'DESC' },
};

const FAILURE_GROUP_FIELD: Record<FailureGroupBy, string> = {
  year: 'FAILYR',
  state: 'PSTALP',
  method: 'RESTYPE1',
  insurance_fund: 'SAVR',
};

function metricFields(metrics: readonly MetricName[]): string[] {
  return metrics.map((metric) => METRIC_CATALOG[metric].field);
}

function failureClause(f: FailureFilters): Clause | undefined {
  return and(
    f.nameTokens?.length ? containsAllTokens('NAME', f.nameTokens) : undefined,
    f.certs?.length ? anyOf('CERT', f.certs) : undefined,
    f.state ? eq('PSTALP', f.state) : undefined,
    f.from || f.to ? range('FAILDATE', f.from, f.to) : undefined,
    f.resolution === 'all' ? undefined : eq('RESTYPE', f.resolution.toUpperCase()),
    f.methods?.length ? anyOf('RESTYPE1', f.methods) : undefined,
    f.minAssets !== undefined ? range('QBFASSET', f.minAssets, undefined) : undefined,
  );
}

/**
 * A panel's shared filters. A threshold on a zero-means-unreported metric also
 * excludes `0`, so an upper bound never admits the filers that did not report it.
 */
function panelClause(f: PanelFilters): Clause | undefined {
  return and(
    f.certs?.length ? anyOf('CERT', f.certs) : undefined,
    f.state ? eq('STALP', f.state) : undefined,
    f.minAssets !== undefined || f.maxAssets !== undefined
      ? range('ASSET', f.minAssets, f.maxAssets)
      : undefined,
    ...(f.metricFilters ?? []).map((mf) => {
      const def = METRIC_CATALOG[mf.metric];
      return and(
        range(def.field, mf.min, mf.max),
        def.zeroMeansUnreported ? notEq(def.field, 0) : undefined,
      );
    }),
  );
}

/** Branch-level fields of one Summary of Deposits row. */
const BRANCH_FIELDS = [
  'CERT',
  'NAMEFULL',
  'BRNUM',
  'UNINUMBR',
  'NAMEBR',
  'BKMO',
  'ADDRESBR',
  'CITYBR',
  'CNTYNAMB',
  'STALPBR',
  'ZIPBR',
  'MSABR',
  'MSANAMB',
  'DEPSUMBR',
  'SIMS_ESTABLISHED_DATE',
  'SIMS_LATITUDE',
  'SIMS_LONGITUDE',
].join(',');

/**
 * Institution-level `/history` fields: the row keys, the four institutions a row
 * can name (`SUR_`, `OUT_`, `ACQ_`, `FRM_`), and the attributes a change moves.
 */
const HISTORY_INSTITUTION_FIELDS = [
  'ID',
  'TRANSNUM',
  'CERT',
  'CHANGECODE',
  'CHANGECODE_DESC',
  'EFFDATE',
  'SUR_CERT',
  'SUR_INSTNAME',
  'OUT_CERT',
  'OUT_INSTNAME',
  'ACQ_CERT',
  'ACQ_INSTNAME',
  'FRM_CERT',
  'FRM_INSTNAME',
  'INSTNAME',
  'PADDR',
  'PCITY',
  'PSTALP',
  'CLASS',
  'CHARTAGENT',
  'REGAGENT',
  'FRM_PADDR',
  'FRM_PCITY',
  'FRM_PSTALP',
  'FRM_CLASS',
  'FRM_CHARTAGENT',
  'FRM_REGAGENT',
].join(',');

/** Branch-level `/history` fields: the row keys and the office before and after. */
const HISTORY_BRANCH_FIELDS = [
  'ID',
  'TRANSNUM',
  'CERT',
  'CHANGECODE',
  'CHANGECODE_DESC',
  'EFFDATE',
  'OFF_NAME',
  'OFF_NUM',
  'OFF_PADDR',
  'OFF_PCITY',
  'OFF_PSTALP',
  'FRM_OFF_NAME',
  'FRM_OFF_PADDR',
  'FRM_OFF_PCITY',
  'FRM_OFF_PSTALP',
].join(',');

/**
 * A Summary of Deposits geography. `CNTYNAMB` and `CITYBR` match exactly and
 * case-sensitively upstream, so every spelling FDIC records a place under is sent:
 * {@link countyVariants} for the county (a `Name (City)` county also as
 * `Name City`), {@link caseVariants} for the city.
 */
function sodGeoClause(g: SodGeography | undefined): Clause | undefined {
  if (!g) return;
  return and(
    g.state ? eq('STALPBR', g.state) : undefined,
    g.county ? anyOf('CNTYNAMB', countyVariants(g.county)) : undefined,
    g.city ? anyOf('CITYBR', caseVariants(g.city)) : undefined,
    g.zip ? eq('ZIPBR', g.zip) : undefined,
    g.msaCode !== undefined ? eq('MSABR', g.msaCode) : undefined,
  );
}

function sodBucket(data: Record<string, unknown>): SodBucket {
  return { branchCount: num(data.count) ?? 0, deposits: num(data.sum_DEPSUMBR) ?? 0 };
}

/**
 * Which quarters of a panel to fetch under a row cap: whole quarters, newest
 * first, until the next one would overflow — so a capped panel is missing its
 * oldest quarters rather than an arbitrary slice of one. Only when the newest
 * quarter alone exceeds the cap is it fetched partially (its lowest CERTs).
 */
export function planPanelQuarters(
  quarters: readonly PanelQuarter[],
  maxRows: number,
): PanelQuarter[] {
  const plan: PanelQuarter[] = [];
  let used = 0;
  for (const quarter of quarters) {
    if (used + quarter.rows > maxRows) {
      if (plan.length === 0) plan.push({ reportDate: quarter.reportDate, rows: maxRows });
      break;
    }
    plan.push(quarter);
    used += quarter.rows;
  }
  return plan;
}

/** Contiguous planned quarters fetched together, newest first; `rows` is their planned sum. */
interface PanelRun {
  newest: string;
  oldest: string;
  rows: number;
}

/**
 * Groups a plan's quarters, newest first, into contiguous runs of at most one
 * page (10,000 rows); a quarter larger than a page is a run of its own. The
 * plan is a prefix of the preflight's non-empty quarters, so a `REPDTE` range
 * over a run selects no other matching quarter.
 */
function panelRuns(plan: readonly PanelQuarter[]): PanelRun[] {
  const runs: PanelRun[] = [];
  for (const quarter of plan) {
    const run = runs.at(-1);
    if (run && run.rows + quarter.rows <= MAX_PAGE) {
      run.oldest = quarter.reportDate;
      run.rows += quarter.rows;
    } else {
      runs.push({ newest: quarter.reportDate, oldest: quarter.reportDate, rows: quarter.rows });
    }
  }
  return runs;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function totalsOf(block: Record<string, unknown>, prefix = ''): FailureTotals {
  return {
    count: num(block.count) ?? 0,
    assets: num(block[`${prefix}QBFASSET`]) ?? 0,
    deposits: num(block[`${prefix}QBFDEP`]) ?? 0,
    cost: num(block[`${prefix}COST`]) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface InFlight {
  promise: Promise<FdicEnvelope>;
  signal: AbortSignal;
}

/** A relevance chunk as served, and whether its order matched the one earlier pages were cut from. */
interface OrderedChunk {
  confirmed: boolean;
  envelope: FdicEnvelope;
}

export class FdicService {
  private readonly cache: ResponseCache;
  private readonly getJson: GetJson;
  private readonly inflight = new Map<string, InFlight>();
  private readonly orders = new ChunkOrders();
  private readonly pacer: Pacer;

  constructor(options: FdicServiceOptions = {}) {
    this.getJson =
      options.getJson ??
      createFetchJson(
        `fdic-banks-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/fdic-banks-mcp-server)`,
      );
    this.pacer =
      options.pacer ??
      createPacer({
        name: 'fdic',
        minStartGapMs: Math.ceil(1000 / getServerConfig().rateLimitRps),
        maxConcurrent: 4,
        cooldown: { baseMs: COOLDOWN_BASE_MS, maxMs: 60_000 },
      });
    this.cache = new ResponseCache(
      (options.cacheTtlSeconds ?? getServerConfig().cacheTtlSeconds) * 1000,
      options.now ?? Date.now,
    );
  }

  /** Releases the pacer's dispatch timer and queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  /** One BankFind request through the full pipeline. */
  async query(
    endpoint: Endpoint,
    params: Params,
    ctx: Context,
    budget: CallBudget,
  ): Promise<FdicEnvelope> {
    const url = buildUrl(endpoint, params);
    try {
      return await this.fetchEnvelope(url, endpoint, ctx, budget);
    } catch (err) {
      throw mapFailure(err, ctx);
    }
  }

  private async fetchEnvelope(
    url: URL,
    endpoint: Endpoint,
    ctx: Context,
    budget: CallBudget,
  ): Promise<FdicEnvelope> {
    const key = url.toString();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const pending = this.inflight.get(key);
    if (pending) {
      try {
        return await pending.promise;
      } catch (err) {
        // The originating caller cancelled; a live caller issues its own request.
        if (!pending.signal.aborted || ctx.signal.aborted) throw err;
      }
    }

    const entry: InFlight = {
      promise: this.fetchUncached(url, endpoint, ctx, budget),
      signal: ctx.signal,
    };
    this.inflight.set(key, entry);
    try {
      const envelope = await entry.promise;
      this.cache.set(key, envelope);
      return envelope;
    } finally {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    }
  }

  private fetchUncached(
    url: URL,
    endpoint: Endpoint,
    ctx: Context,
    budget: CallBudget,
  ): Promise<FdicEnvelope> {
    return withRetry(
      async ({ signal, remainingMs }) => {
        const body = await this.pacer.run(
          (taskSignal) =>
            this.getJson(url, {
              signal: taskSignal,
              timeoutMs: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, budget.deadlineAt - Date.now())),
              context: ctx,
            }),
          { signal, maxWaitMs: Math.min(MAX_QUEUE_WAIT_MS, remainingMs) },
        );
        return parseEnvelope(body);
      },
      {
        operation: `FdicService.${endpoint}`,
        context: ctx,
        signal: ctx.signal,
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 10_000,
        deadlineMs: Math.max(1, budget.deadlineAt - Date.now()),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Institutions
  // -------------------------------------------------------------------------

  /**
   * One page of institutions. Relevance order for a name search is two tiers:
   * active institutions whose current name holds every query word, then every
   * other match, each in FDIC's match-score order — the score alone ranks inactive
   * affiliates and fuzzy or former-name matches above the operating bank a query
   * names. The two tiers partition the match set, so `total` is their sum; a
   * `status: inactive` search holds no active match and is one tier. Tiers are
   * read in chunks ({@link FdicService.scoreOrderedPage}). A sorted search sends
   * `CERT` after its sort field, so FDIC breaks ties the same way on every
   * request and offset pages never overlap.
   */
  async searchInstitutions(
    q: InstitutionSearch,
    ctx: Context,
    budget: CallBudget,
  ): Promise<InstitutionPage> {
    const filters = and(
      q.certs?.length ? anyOf('CERT', q.certs) : undefined,
      q.state ? eq('STALP', q.state) : undefined,
      q.city ? anyOf('CITY', caseVariants(q.city)) : undefined,
      q.status === 'any' ? undefined : eq('ACTIVE', q.status === 'active' ? 1 : 0),
      q.bankClasses?.length ? anyOf('BKCLASS', q.bankClasses) : undefined,
      q.minAssets !== undefined || q.maxAssets !== undefined
        ? range('ASSET', q.minAssets, q.maxAssets)
        : undefined,
      q.holdingCompanyRssd !== undefined ? eq('RSSDHCR', String(q.holdingCompanyRssd)) : undefined,
    );
    if (q.sort === 'relevance' && q.name) {
      const current =
        q.status === 'inactive'
          ? undefined
          : and(
              q.status === 'any' ? eq('ACTIVE', 1) : undefined,
              containsAllTokens('NAME', nameTokens(q.name)),
            );
      const tiers = current ? [and(filters, current), and(filters, not(current))] : [filters];
      return this.scoreOrderedPage(`NAME:${q.name}`, tiers, q.offset, q.limit, ctx, budget);
    }

    const sort =
      q.sort === 'relevance'
        ? undefined
        : q.sort === 'name'
          ? { sort_by: 'NAME,CERT', sort_order: 'ASC' }
          : { sort_by: 'ASSET,CERT', sort_order: 'DESC' };
    const envelope = await this.query(
      'institutions',
      {
        search: q.name ? `NAME:${q.name}` : undefined,
        filters,
        fields: INSTITUTION_FIELDS,
        limit: q.limit,
        offset: q.offset,
        ...sort,
      },
      ctx,
      budget,
    );
    return {
      rows: envelope.rows.map(normalizeInstitution),
      total: envelope.total,
      dataAsOf: envelope.dataAsOf,
      orderUnconfirmed: false,
    };
  }

  /**
   * One page of a relevance search, cut from its tiers in 10,000-match chunks.
   * FDIC answers the same `search` request in either of two orders whose match
   * scores differ, so pages read by their own `offset` requests mix both: a match
   * comes back twice and another never. Each tier is read instead in chunks at
   * multiples of 10,000, and every page is sliced from them in the order its
   * chunks were first served ({@link FdicService.orderedChunk}), so a walk returns
   * each match once. A tier the page does not reach is only counted (`limit=0`);
   * on the first page the first tier's first chunk stands in for its count. The
   * first read to fail aborts every other read of the call, retries included.
   */
  private async scoreOrderedPage(
    search: string,
    tiers: readonly (Clause | undefined)[],
    offset: number,
    limit: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<InstitutionPage> {
    const local = new AbortController();
    const readCtx: Context = { ...ctx, signal: AbortSignal.any([ctx.signal, local.signal]) };
    // One read per chunk within the call, even with the response cache off.
    const reads = new Map<string, Promise<OrderedChunk>>();
    const chunk = (tier: number, index: number): Promise<OrderedChunk> => {
      const key = `${tier}:${index}`;
      let read = reads.get(key);
      if (!read) {
        const params: Params = {
          search,
          filters: tiers[tier],
          fields: INSTITUTION_FIELDS,
          limit: MAX_PAGE,
          offset: index * MAX_PAGE,
        };
        read = this.orderedChunk(
          params,
          JSON.stringify([search, tiers[tier]]),
          index,
          readCtx,
          budget,
        );
        reads.set(key, read);
      }
      return read;
    };

    try {
      const heads = await Promise.all(
        tiers.map((filters, tier) =>
          tier === 0 && offset === 0
            ? chunk(0, 0).then((c) => c.envelope)
            : this.query('institutions', { search, filters, limit: 0 }, readCtx, budget),
        ),
      );

      // Each tier's part of the page, as row ranges [from, to) within its chunks.
      const end = offset + limit;
      const slices: { from: number; index: number; tier: number; to: number }[] = [];
      let start = 0;
      for (const [tier, head] of heads.entries()) {
        const from = Math.max(offset, start) - start;
        const to = Math.min(end, start + head.total) - start;
        for (let index = Math.floor(from / MAX_PAGE); from < to && index * MAX_PAGE < to; index++) {
          const base = index * MAX_PAGE;
          slices.push({
            tier,
            index,
            from: Math.max(from, base) - base,
            to: Math.min(to, base + MAX_PAGE) - base,
          });
        }
        start += head.total;
      }

      const parts = await Promise.all(
        slices.map(async (s) => ({ ...s, read: await chunk(s.tier, s.index) })),
      );
      return {
        rows: parts
          .flatMap((p) => p.read.envelope.rows.slice(p.from, p.to))
          .map(normalizeInstitution),
        total: start,
        dataAsOf: (heads[0] as FdicEnvelope).dataAsOf,
        orderUnconfirmed: offset > 0 && parts.some((p) => !p.read.confirmed),
      };
    } catch (err) {
      local.abort();
      throw err;
    }
  }

  /**
   * One relevance chunk, in the order earlier pages of its search were cut from.
   * The read goes through the cache and in-flight dedupe; while it disagrees with
   * the tier's record ({@link ChunkOrders.align}), the chunk is read again past
   * both, up to {@link MAX_ORDER_REREADS} times and only while the budget leaves
   * twice the slowest read so far. A read holding the recorded CERTs is served in
   * the recorded order, with no further request. What is served becomes the record
   * and the cache entry; it is `confirmed` unless the re-reads ran out or failed or
   * FDIC rebuilt its index. A failed re-read serves the read in hand; cancellation
   * always throws.
   */
  private async orderedChunk(
    params: Params,
    tier: string,
    index: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<OrderedChunk> {
    const url = buildUrl('institutions', params);
    let startedAt = Date.now();
    const first = await this.query('institutions', params, ctx, budget);
    let slowestMs = Date.now() - startedAt;
    let envelope = first;
    let confirmed = false;
    for (let rereads = 0; ; rereads++) {
      const alignment = this.orders.align(tier, index, envelope);
      if (alignment.kind === 'aligned') {
        confirmed = true;
        if (alignment.rows !== envelope.rows) envelope = { ...envelope, rows: alignment.rows };
        break;
      }
      if (alignment.kind === 'rebuilt') break;
      if (rereads === MAX_ORDER_REREADS || budget.deadlineAt - Date.now() < 2 * slowestMs) break;
      try {
        startedAt = Date.now();
        envelope = await this.fetchUncached(url, 'institutions', ctx, budget);
        slowestMs = Math.max(slowestMs, Date.now() - startedAt);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        break;
      }
    }
    ctx.signal.throwIfAborted();
    this.orders.record(tier, index, envelope);
    if (envelope !== first) this.cache.set(url.toString(), envelope);
    return { envelope, confirmed };
  }

  /** The institution record for one CERT, active or not. */
  async getInstitution(
    cert: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; institution?: InstitutionRecord }> {
    const envelope = await this.query(
      'institutions',
      { filters: eq('CERT', cert), fields: INSTITUTION_FIELDS, limit: 1 },
      ctx,
      budget,
    );
    const row = envelope.rows[0];
    return {
      dataAsOf: envelope.dataAsOf,
      ...(row ? { institution: normalizeInstitution(row) } : {}),
    };
  }

  /** Which of these CERTs have an institution record at all. */
  async existingCerts(
    certs: readonly number[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<Set<number>> {
    const envelope = await this.query(
      'institutions',
      { filters: anyOf('CERT', certs), fields: 'CERT', limit: certs.length },
      ctx,
      budget,
    );
    return new Set(envelope.rows.map((row) => num(row.data.CERT)).filter((c) => c !== null));
  }

  // -------------------------------------------------------------------------
  // Financials
  // -------------------------------------------------------------------------

  /** Latest quarter FDIC has published (ISO), via the shared cache. */
  async latestReportDate(
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; reportDate: string }> {
    const envelope = await this.query(
      'financials',
      { fields: 'REPDTE', sort_by: 'REPDTE', sort_order: 'DESC', limit: 1 },
      ctx,
      budget,
    );
    const repdte = str(envelope.rows[0]?.data.REPDTE);
    if (!repdte) throw serviceUnavailable('FDIC returned no financial report dates.');
    return { reportDate: repdteToIso(repdte), dataAsOf: envelope.dataAsOf };
  }

  /** One institution's quarterly history, most recent first. */
  async getFinancialHistory(
    q: { cert: number; from?: string; limit: number; metrics: readonly MetricName[]; to?: string },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; rows: FinancialRow[]; total: number }> {
    const envelope = await this.query(
      'financials',
      {
        filters: and(
          eq('CERT', q.cert),
          q.from || q.to
            ? range(
                'REPDTE',
                q.from ? isoToRepdte(q.from) : undefined,
                q.to ? isoToRepdte(q.to) : undefined,
              )
            : undefined,
        ),
        fields: ['REPDTE', ...metricFields(q.metrics)].join(','),
        sort_by: 'REPDTE',
        sort_order: 'DESC',
        limit: q.limit,
      },
      ctx,
      budget,
    );
    return {
      rows: envelope.rows.map((row) => ({
        report_date: repdteToIso(str(row.data.REPDTE) ?? ''),
        values: metricValues(row.data, q.metrics),
      })),
      total: envelope.total,
      dataAsOf: envelope.dataAsOf,
    };
  }

  /** One institution's Call Report row for one quarter, or undefined when it filed none. */
  async getQuarterRow(
    cert: number,
    reportDate: string,
    metrics: readonly MetricName[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<{
    dataAsOf: string;
    row?: { name: string; state: string; totalAssets: number | null; values: MetricValues };
  }> {
    const envelope = await this.query(
      'financials',
      {
        filters: and(eq('CERT', cert), eq('REPDTE', isoToRepdte(reportDate))),
        // total_assets maps to ASSET, which this row always needs.
        fields: [...new Set(['NAME', 'STALP', 'ASSET', ...metricFields(metrics)])].join(','),
        limit: 1,
      },
      ctx,
      budget,
    );
    const data = envelope.rows[0]?.data;
    return {
      dataAsOf: envelope.dataAsOf,
      ...(data
        ? {
            row: {
              name: str(data.NAME) ?? '',
              state: str(data.STALP) ?? '',
              totalAssets: num(data.ASSET),
              values: metricValues(data, metrics),
            },
          }
        : {}),
    };
  }

  /**
   * Every filer in a peer group for one quarter, paged by CERT. Either `certs`
   * (an explicit list) or the band and state filters apply.
   */
  async getPeerRows(
    q: {
      certs?: readonly number[];
      maxAssets?: number;
      metrics: readonly MetricName[];
      minAssets?: number;
      reportDate: string;
      state?: StateCode;
    },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; rows: Array<{ cert: number; values: MetricValues }> }> {
    const repdte = eq('REPDTE', isoToRepdte(q.reportDate));
    const filters = q.certs
      ? and(anyOf('CERT', q.certs), repdte)
      : and(
          repdte,
          q.minAssets !== undefined || q.maxAssets !== undefined
            ? range('ASSET', q.minAssets, q.maxAssets, { upperExclusive: true })
            : undefined,
          q.state ? eq('STALP', q.state) : undefined,
        );
    const fields = ['CERT', ...metricFields(q.metrics)].join(',');
    const rows: Array<{ cert: number; values: MetricValues }> = [];
    let dataAsOf = '';
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += MAX_PAGE) {
      const envelope = await this.query(
        'financials',
        { filters, fields, sort_by: 'CERT', sort_order: 'ASC', limit: MAX_PAGE, offset },
        ctx,
        budget,
      );
      total = envelope.total;
      dataAsOf = envelope.dataAsOf;
      for (const row of envelope.rows) {
        const cert = num(row.data.CERT);
        if (cert !== null) rows.push({ cert, values: metricValues(row.data, q.metrics) });
      }
      if (envelope.rows.length === 0) break;
    }
    return { rows, dataAsOf };
  }

  /**
   * Panel preflight: rows per quarter matching the filters between two ISO
   * quarter-ends, newest quarter first, plus the total, in one aggregation call.
   */
  async panelQuarterCounts(
    filters: PanelFilters,
    from: string,
    to: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; quarters: PanelQuarter[]; total: number }> {
    const envelope = await this.query(
      'financials',
      {
        filters: and(range('REPDTE', isoToRepdte(from), isoToRepdte(to)), panelClause(filters)),
        agg_by: 'REPDTE',
        agg_limit: MAX_PAGE,
        limit: 0,
      },
      ctx,
      budget,
    );
    const quarters = envelope.rows
      .map((row) => ({
        reportDate: repdteToIso(str(row.data.REPDTE) ?? ''),
        rows: num(row.data.count) ?? 0,
      }))
      .filter((q) => q.rows > 0)
      .sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1));
    return { quarters, total: envelope.total, dataAsOf: envelope.dataAsOf };
  }

  /**
   * The panel rows for planned quarters. Contiguous quarters that together fit
   * one page are fetched in one request over their `REPDTE` range; a quarter
   * larger than a page is offset-paged alone by CERT, the only key unique within
   * a quarter (the row ID is not sortable), so offset paging never spans
   * quarters. Up to three runs are in flight; each stops at its planned row count.
   */
  async getPanelRows(
    filters: PanelFilters,
    plan: readonly PanelQuarter[],
    metrics: readonly MetricName[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<PanelRow[]> {
    const base = panelClause(filters);
    const fields = ['CERT', 'NAME', 'STALP', 'REPDTE', ...metricFields(metrics)].join(',');
    const perRun = await mapPool(panelRuns(plan), PANEL_RUN_CONCURRENCY, async (run) => {
      const clause = and(
        base,
        run.newest === run.oldest
          ? eq('REPDTE', isoToRepdte(run.newest))
          : range('REPDTE', isoToRepdte(run.oldest), isoToRepdte(run.newest)),
      );
      const rows: PanelRow[] = [];
      let fetched = 0;
      while (fetched < run.rows) {
        const limit = Math.min(MAX_PAGE, run.rows - fetched);
        const envelope = await this.query(
          'financials',
          {
            filters: clause,
            fields,
            sort_by: 'CERT',
            sort_order: 'ASC',
            limit,
            offset: fetched,
          },
          ctx,
          budget,
        );
        fetched += envelope.rows.length;
        for (const row of envelope.rows) {
          const cert = num(row.data.CERT);
          const repdte = str(row.data.REPDTE);
          if (cert === null || repdte === undefined) continue;
          rows.push({
            cert,
            name: str(row.data.NAME) ?? '',
            state: str(row.data.STALP) ?? '',
            report_date: repdteToIso(repdte),
            values: metricValues(row.data, metrics),
          });
        }
        if (envelope.rows.length < limit) break;
      }
      return rows;
    });
    return perRun.flat();
  }

  // -------------------------------------------------------------------------
  // Failures
  // -------------------------------------------------------------------------

  /** A page of failure events plus totals and per-method subtotals over every match. */
  async searchFailures(
    filters: FailureFilters,
    page: { limit: number; offset: number; sort: FailureSort },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{
    byMethod: FailureBucket[];
    dataAsOf: string;
    rows: FailureRecord[];
    total: number;
    totals: FailureTotals;
  }> {
    const sort = FAILURE_SORT[page.sort];
    const envelope = await this.query(
      'failures',
      {
        filters: failureClause(filters),
        fields: FAILURE_FIELDS,
        sort_by: sort.field,
        sort_order: sort.order,
        limit: page.limit,
        offset: page.offset,
        total_fields: 'QBFASSET,QBFDEP,COST',
        subtotal_by: 'RESTYPE1',
      },
      ctx,
      budget,
    );
    const subtotals = envelope.totals.subtotal_by_RESTYPE1;
    const byMethod = (Array.isArray(subtotals) ? subtotals : [])
      .filter(isRecord)
      .map((s) => ({ key: str(s.RESTYPE1) ?? '', ...totalsOf(s) }));
    return {
      rows: envelope.rows.map(normalizeFailure),
      total: envelope.total,
      totals: { ...totalsOf(envelope.totals), count: envelope.total },
      byMethod,
      dataAsOf: envelope.dataAsOf,
    };
  }

  /**
   * Per-bucket sums or missing-amount counts over every match. Missing queries
   * also count resolution methods so one request supplies all completeness scopes.
   */
  async aggregateFailures(
    filters: FailureFilters,
    groupBy: FailureGroupBy,
    options: { missingField?: 'COST' | 'QBFASSET' | 'QBFDEP' },
    ctx: Context,
    budget: CallBudget,
  ): Promise<FailureAggregation> {
    const field = FAILURE_GROUP_FIELD[groupBy];
    const { missingField } = options;
    const envelope = await this.query(
      'failures',
      {
        filters: missingField
          ? and(failureClause(filters), notExists(missingField))
          : failureClause(filters),
        agg_by: field,
        agg_sum_fields: missingField ? undefined : 'COST,QBFASSET,QBFDEP',
        agg_term_fields: missingField && groupBy !== 'method' ? 'RESTYPE1' : undefined,
        agg_limit: MAX_PAGE,
        limit: 0,
      },
      ctx,
      budget,
    );
    return {
      total: envelope.total,
      byMethod:
        groupBy === 'method'
          ? new Map(
              envelope.rows.map((row) => [str(row.data.RESTYPE1) ?? '', num(row.data.count) ?? 0]),
            )
          : new Map(
              Object.entries(envelope.totals)
                .filter(([key]) => key.startsWith('count_RESTYPE1_'))
                .map(([key, value]) => [key.slice('count_RESTYPE1_'.length), num(value) ?? 0]),
            ),
      buckets: envelope.rows.map((row) => ({
        key: str(row.data[field]) ?? '',
        ...totalsOf(row.data, 'sum_'),
      })),
    };
  }

  /** Date of the most recent failure or assistance event on record (ISO). */
  async latestFailureDate(ctx: Context, budget: CallBudget): Promise<string | undefined> {
    const envelope = await this.query(
      'failures',
      { fields: 'FAILDATE', sort_by: 'FAILDATE', sort_order: 'DESC', limit: 1 },
      ctx,
      budget,
    );
    const raw = str(envelope.rows[0]?.data.FAILDATE);
    return raw ? usDateToIso(raw) : undefined;
  }

  // -------------------------------------------------------------------------
  // Structure-change history
  // -------------------------------------------------------------------------

  /**
   * One institution's structure-change events of the given types, newest first,
   * within an optional effective-date window. Institution-level rows are read
   * whole — every exit's two rows are needed to pair them, whatever their type or
   * date — and filtered here; branch-level rows need no pairing, so the window
   * goes upstream. The two reads run in parallel under one budget.
   */
  async getInstitutionHistory(
    q: { cert: number; eventTypes: readonly EventType[]; from?: string; to?: string },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; events: HistoryEvent[] }> {
    const types = new Set(q.eventTypes);
    const [institution, branch] = await Promise.all([
      q.eventTypes.some((type) => type !== 'branch')
        ? this.readHistory(
            and(
              eq('ORG_ROLE_CDE', 'FI'),
              or(eq('CERT', q.cert), eq('OUT_CERT', q.cert), eq('SUR_CERT', q.cert)),
            ),
            HISTORY_INSTITUTION_FIELDS,
            {},
            ctx,
            budget,
          )
        : undefined,
      types.has('branch')
        ? this.readHistory(
            and(eq('CERT', q.cert), eq('ORG_ROLE_CDE', 'BR')),
            HISTORY_BRANCH_FIELDS,
            { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) },
            ctx,
            budget,
          )
        : undefined,
    ]);
    const source = institution ?? branch;
    if (!source) throw new Error('getInstitutionHistory needs at least one event type.');
    const events = historyEvents(q.cert, institution?.rows ?? [], branch?.rows ?? []).filter(
      (event) =>
        types.has(event.event_type) &&
        (q.from === undefined || event.effective_date >= q.from) &&
        (q.to === undefined || event.effective_date <= q.to),
    );
    return { dataAsOf: source.dataAsOf, events };
  }

  /**
   * Every `/history` row matching `base` within an effective-date window, deduped
   * by `ID`. `ID` is not sortable and dates tie, so offset paging under a date
   * sort can repeat or skip rows; instead each page is the window sorted
   * `EFFDATE` descending and the next page narrows the window's upper bound to
   * the oldest date read, rereading that date's rows. The upper bound falls with
   * every page, so the walk ends: a page whose oldest date is below its newest
   * moves the bound down to that oldest date; a full page holding one date alone
   * (no CERT has come near: the most on one date is 3,439 rows) has that date
   * read by offset, sorted by `TRANSNUM`, and the walk continues strictly below it.
   */
  private async readHistory(
    base: Clause | undefined,
    fields: string,
    window: { from?: string; to?: string },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; rows: HistoryRow[] }> {
    const rows = new Map<string, HistoryRow>();
    let dataAsOf = '';
    let upper: { date: string; exclusive: boolean } | undefined = window.to
      ? { date: window.to, exclusive: false }
      : undefined;
    for (;;) {
      const dates =
        window.from !== undefined || upper !== undefined
          ? range('EFFDATE', window.from, upper?.date, {
              upperExclusive: upper?.exclusive ?? false,
            })
          : undefined;
      const envelope = await this.query(
        'history',
        {
          filters: and(base, dates),
          fields,
          sort_by: 'EFFDATE',
          sort_order: 'DESC',
          limit: MAX_PAGE,
        },
        ctx,
        budget,
      );
      dataAsOf = envelope.dataAsOf;
      const page = historyRows(envelope);
      for (const row of page) rows.set(row.id, row);
      const newest = page[0]?.effectiveDate;
      const oldest = page.at(-1)?.effectiveDate;
      if (newest === undefined || oldest === undefined || envelope.total <= page.length) break;
      if (oldest !== newest) {
        upper = { date: oldest, exclusive: false };
        continue;
      }
      const day = and(base, range('EFFDATE', oldest, oldest));
      let total = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < total; offset += MAX_PAGE) {
        const dayPage = await this.query(
          'history',
          {
            filters: day,
            fields,
            sort_by: 'TRANSNUM',
            sort_order: 'DESC',
            limit: MAX_PAGE,
            offset,
          },
          ctx,
          budget,
        );
        total = dayPage.total;
        const dayRows = historyRows(dayPage);
        for (const row of dayRows) rows.set(row.id, row);
        if (dayRows.length === 0) break;
      }
      upper = { date: oldest, exclusive: true };
    }
    return { dataAsOf, rows: [...rows.values()] };
  }

  // -------------------------------------------------------------------------
  // Summary of Deposits
  // -------------------------------------------------------------------------

  /** Latest Summary of Deposits survey year in the index, via the shared cache. */
  async latestSodYear(
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; year: number }> {
    const envelope = await this.query(
      'sod',
      { fields: 'YEAR', sort_by: 'YEAR', sort_order: 'DESC', limit: 1 },
      ctx,
      budget,
    );
    const year = num(envelope.rows[0]?.data.YEAR);
    if (year === null) throw serviceUnavailable('FDIC returned no Summary of Deposits years.');
    return { year, dataAsOf: envelope.dataAsOf };
  }

  /**
   * One institution's branches for one survey year, optionally within a
   * geography, in branch-number order (main office first), paged at 10,000.
   */
  async getBranches(
    q: { cert: number; geography?: SodGeography; year: number },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; institutionName?: string; rows: BranchRecord[] }> {
    const filters = and(eq('CERT', q.cert), sodGeoClause(q.geography), eq('YEAR', q.year));
    const rows: BranchRecord[] = [];
    let institutionName: string | undefined;
    let dataAsOf = '';
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += MAX_PAGE) {
      const envelope = await this.query(
        'sod',
        {
          filters,
          fields: BRANCH_FIELDS,
          sort_by: 'BRNUM',
          sort_order: 'ASC',
          limit: MAX_PAGE,
          offset,
        },
        ctx,
        budget,
      );
      total = envelope.total;
      dataAsOf = envelope.dataAsOf;
      institutionName ??= str(envelope.rows[0]?.data.NAMEFULL);
      rows.push(...envelope.rows.map(normalizeBranch));
      if (envelope.rows.length === 0) break;
    }
    return { rows, dataAsOf, ...(institutionName ? { institutionName } : {}) };
  }

  /**
   * Every institution's branch count and deposit sum in a geography for one
   * year. Buckets arrive in CERT order and `agg_limit` truncates by CERT, so all
   * of them are fetched: the widest geography, a state or a multi-state MSA, is
   * far under the 10,000-bucket cap (the whole national market is 4,249
   * institutions in 2026).
   */
  async sodMarketByCert(
    q: { geography: SodGeography; year: number },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ buckets: Map<number, SodBucket>; dataAsOf: string }> {
    const envelope = await this.query(
      'sod',
      {
        filters: and(sodGeoClause(q.geography), eq('YEAR', q.year)),
        agg_by: 'CERT',
        agg_sum_fields: 'DEPSUMBR',
        agg_limit: MAX_PAGE,
        limit: 0,
      },
      ctx,
      budget,
    );
    const buckets = new Map<number, SodBucket>();
    for (const row of envelope.rows) {
      const cert = num(row.data.CERT);
      if (cert !== null) buckets.set(cert, sodBucket(row.data));
    }
    return { buckets, dataAsOf: envelope.dataAsOf };
  }

  /** Branch count and deposit sum of every state's market for one survey year. */
  async sodStateMarkets(
    year: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Map<string, SodBucket>> {
    const envelope = await this.query(
      'sod',
      {
        filters: eq('YEAR', year),
        agg_by: 'STALPBR',
        agg_sum_fields: 'DEPSUMBR',
        agg_limit: MAX_PAGE,
        limit: 0,
      },
      ctx,
      budget,
    );
    const states = new Map<string, SodBucket>();
    for (const row of envelope.rows) {
      const state = str(row.data.STALPBR);
      if (state) states.set(state, sodBucket(row.data));
    }
    return states;
  }

  /** Current names (or the name at closing) of a few CERTs from their institution records. */
  async institutionNames(
    certs: readonly number[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<Map<number, string>> {
    if (certs.length === 0) return new Map();
    const envelope = await this.query(
      'institutions',
      { filters: anyOf('CERT', certs), fields: 'CERT,NAME', limit: certs.length },
      ctx,
      budget,
    );
    return namesOf(envelope);
  }

  /**
   * CERT → name for every institution record, active and inactive, in three
   * 10,000-row pages that ride the shared cache. Used when a whole market is staged.
   */
  async institutionDirectory(ctx: Context, budget: CallBudget): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += MAX_PAGE) {
      const envelope = await this.query(
        'institutions',
        { fields: 'CERT,NAME', sort_by: 'CERT', sort_order: 'ASC', limit: MAX_PAGE, offset },
        ctx,
        budget,
      );
      total = envelope.total;
      for (const [cert, name] of namesOf(envelope)) names.set(cert, name);
      if (envelope.rows.length === 0) break;
    }
    return names;
  }
}

/** A page's `/history` rows; a row missing a key every row carries fails the call. */
function historyRows(envelope: FdicEnvelope): HistoryRow[] {
  return envelope.rows.map((raw) => {
    const row = historyRow(raw);
    if (!row) {
      throw serviceUnavailable(
        'FDIC returned a history row without its ID, effective date, change code, or change description.',
      );
    }
    return row;
  });
}

function namesOf(envelope: FdicEnvelope): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of envelope.rows) {
    const cert = num(row.data.CERT);
    const name = str(row.data.NAME);
    if (cert !== null && name) names.set(cert, name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Init / accessor
// ---------------------------------------------------------------------------

let _service: FdicService | undefined;

/** Installs the service; tests pass one built with fake seams. */
export function initFdicService(service?: FdicService): void {
  _service = service ?? new FdicService();
}

export function getFdicService(): FdicService {
  if (!_service) throw new Error('FdicService not initialized — call initFdicService() in setup()');
  return _service;
}

/** Disposes the pacer; called from `teardown`. */
export function disposeFdicService(): void {
  _service?.dispose();
  _service = undefined;
}
