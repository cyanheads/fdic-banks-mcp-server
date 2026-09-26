/**
 * @fileoverview Client for the FDIC BankFind Suite API (`https://api.fdic.gov/banks`).
 * One pipeline per request — cache → in-flight dedupe → retry (outside) → pacer
 * (inside) → transport → JSON parse → envelope check — plus typed query methods
 * that own the upstream's traps: case-sensitive codes, `REPDTE` as a string field,
 * `sort_by` honored only beside `sort_order`, absence sentinels, and ratios FDIC
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
import { METRIC_CATALOG, type MetricName } from './metric-catalog.js';
import {
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
  eq,
  isoToRepdte,
  notEq,
  notExists,
  range,
  repdteToIso,
  usDateToIso,
} from './query-builder.js';
import type {
  BranchRecord,
  CallBudget,
  FailureBucket,
  FailureFilters,
  FailureGroupBy,
  FailureRecord,
  FailureSort,
  FailureTotals,
  FdicEnvelope,
  FinancialRow,
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
export const TOOL_BUDGET_MS = 45_000;
/** Budget of the multi-quarter panel fetch, the one long-running call. */
export const PANEL_BUDGET_MS = 55_000;
/** Largest page BankFind serves; also the aggregation bucket cap (`agg_limit`). */
const MAX_PAGE = 10_000;
/** Panel quarters fetched concurrently (the pacer still bounds requests in flight). */
const PANEL_QUARTER_CONCURRENCY = 3;
/** Cooldown the pacer applies after a 429; also the wait reported when FDIC names none. */
const COOLDOWN_BASE_MS = 5_000;

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

type Endpoint = 'institutions' | 'financials' | 'failures' | 'sod';
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
  private totalBytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

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
// Envelope and error handling
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** FDIC's 400 envelope → `{ detail, parameter }`, from a parsed body or captured body text. */
function badRequestDetail(body: unknown): { detail?: string; parameter?: string } {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { detail: body };
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
 * Rewraps the two rate-limit shapes under the reasons every data tool declares,
 * with the calling tool's recovery text, and a 400 as this server's fault.
 */
function mapFailure(err: unknown, ctx: Context): unknown {
  if (!(err instanceof McpError)) return err;
  const data = isRecord(err.data) ? err.data : {};
  if (err.code === JsonRpcErrorCode.RateLimited) {
    if (data.reason === 'pacer_shed') {
      return rateLimited(
        err.message,
        { ...data, reason: 'pacer_shed', retryable: true, ...ctx.recoveryFor('pacer_shed') },
        { cause: err },
      );
    }
    return rateLimited(
      'FDIC is throttling requests (HTTP 429) and retries were exhausted.',
      {
        reason: 'upstream_rate_limited',
        retryAfter: retryAfterSeconds(data.retryAfter) ?? COOLDOWN_BASE_MS / 1000,
        retryable: true,
        ...ctx.recoveryFor('upstream_rate_limited'),
      },
      { cause: err },
    );
  }
  if (err.code === JsonRpcErrorCode.InvalidParams) {
    return queryRejected(data.body ?? data.responseBody ?? data, err);
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
 * A panel's shared filters. A threshold on a zero-means-unreported ratio also
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
 * A Summary of Deposits geography. `CNTYNAMB` and `CITYBR` match exactly and
 * case-sensitively upstream, so both the given and title-case spellings are sent.
 */
function sodGeoClause(g: SodGeography | undefined): Clause | undefined {
  if (!g) return;
  return and(
    g.state ? eq('STALPBR', g.state) : undefined,
    g.county ? anyOf('CNTYNAMB', caseVariants(g.county)) : undefined,
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

export class FdicService {
  private readonly cache: ResponseCache;
  private readonly getJson: GetJson;
  private readonly inflight = new Map<string, InFlight>();
  private readonly pacer: Pacer;

  constructor(options: FdicServiceOptions = {}) {
    const needsConfig = options.pacer === undefined || options.cacheTtlSeconds === undefined;
    const cfg = needsConfig ? getServerConfig() : undefined;
    this.getJson =
      options.getJson ??
      createFetchJson(
        `fdic-banks-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/fdic-banks-mcp-server)`,
      );
    this.pacer =
      options.pacer ??
      createPacer({
        name: 'fdic',
        minStartGapMs: Math.ceil(1000 / (cfg?.rateLimitRps ?? 8)),
        maxConcurrent: 4,
        cooldown: { baseMs: COOLDOWN_BASE_MS, maxMs: 60_000 },
      });
    this.cache = new ResponseCache(
      (options.cacheTtlSeconds ?? cfg?.cacheTtlSeconds ?? 3600) * 1000,
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

  async searchInstitutions(
    q: InstitutionSearch,
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ dataAsOf: string; rows: InstitutionRecord[]; total: number }> {
    const sort =
      q.sort === 'relevance'
        ? undefined
        : q.sort === 'name'
          ? { sort_by: 'NAME', sort_order: 'ASC' }
          : { sort_by: 'ASSET', sort_order: 'DESC' };
    const envelope = await this.query(
      'institutions',
      {
        search: q.name ? `NAME:${q.name}` : undefined,
        filters: and(
          q.certs?.length ? anyOf('CERT', q.certs) : undefined,
          q.state ? eq('STALP', q.state) : undefined,
          q.city ? anyOf('CITY', caseVariants(q.city)) : undefined,
          q.status === 'any' ? undefined : eq('ACTIVE', q.status === 'active' ? 1 : 0),
          q.bankClasses?.length ? anyOf('BKCLASS', q.bankClasses) : undefined,
          q.minAssets !== undefined || q.maxAssets !== undefined
            ? range('ASSET', q.minAssets, q.maxAssets)
            : undefined,
          q.holdingCompanyRssd !== undefined
            ? eq('RSSDHCR', String(q.holdingCompanyRssd))
            : undefined,
        ),
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
    };
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
   * The panel rows for planned quarters, paged per quarter by CERT (the only
   * key unique within a quarter; the row ID is not sortable), up to three
   * quarters in flight. Each quarter stops at its planned row count.
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
    const perQuarter = await mapPool(plan, PANEL_QUARTER_CONCURRENCY, async (quarter) => {
      const clause = and(base, eq('REPDTE', isoToRepdte(quarter.reportDate)));
      const rows: PanelRow[] = [];
      let fetched = 0;
      while (fetched < quarter.rows) {
        const limit = Math.min(MAX_PAGE, quarter.rows - fetched);
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
          if (cert === null) continue;
          rows.push({
            cert,
            name: str(row.data.NAME) ?? '',
            state: str(row.data.STALP) ?? '',
            report_date: quarter.reportDate,
            values: metricValues(row.data, metrics),
          });
        }
        if (envelope.rows.length < limit) break;
      }
      return rows;
    });
    return perQuarter.flat();
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
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
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
   * Per-bucket counts and sums over matching events. With `missingCostOnly`, only
   * events FDIC holds no loss estimate for — FDIC's `COST` sums skip them silently.
   */
  async aggregateFailures(
    filters: FailureFilters,
    groupBy: FailureGroupBy,
    options: { missingCostOnly: boolean },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ buckets: FailureBucket[]; total: number }> {
    const field = FAILURE_GROUP_FIELD[groupBy];
    const envelope = await this.query(
      'failures',
      {
        filters: options.missingCostOnly
          ? and(failureClause(filters), notExists('COST'))
          : failureClause(filters),
        agg_by: field,
        agg_sum_fields: options.missingCostOnly ? undefined : 'COST,QBFASSET,QBFDEP',
        agg_limit: MAX_PAGE,
        limit: 0,
      },
      ctx,
      budget,
    );
    return {
      total: envelope.total,
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
