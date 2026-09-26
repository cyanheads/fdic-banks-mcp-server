/**
 * @fileoverview Fake FDIC BankFind transport for tests. Implements the service's
 * `getJson` seam as a route table that records every URL it receives, plus
 * builders for the BankFind response envelope in its recorded shapes (row hits,
 * aggregation buckets, the 400 error body) across all four endpoints, and the
 * quarter matcher that panel page responders serve single quarters and ranges by.
 * @module tests/helpers/fake-fdic
 */

import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { FdicService, type GetJson, initFdicService } from '@/services/fdic/fdic-service.js';

export type FdicEndpoint = 'institutions' | 'financials' | 'failures' | 'sod';

/** One request the fake received, with its query parameters decoded. */
export interface FakeRequest {
  readonly endpoint: FdicEndpoint;
  readonly params: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: URL;
}

type Params = Readonly<Record<string, string>>;
type Responder = (request: FakeRequest) => unknown;
/** A fixed JSON body, cloned per request. */
type JsonBody = Record<string, unknown> | readonly unknown[];

interface FakeRoute {
  endpoint: FdicEndpoint;
  match: (params: Params) => boolean;
  respond: Responder;
}

/**
 * Route-table fake of the FDIC transport. Routes match in registration order; an
 * unmatched request fails as a non-retryable `InternalError` naming the URL, so a
 * missing route fails the test at once instead of sitting in a retry backoff.
 */
export class FakeFdic {
  readonly requests: FakeRequest[] = [];
  readonly #routes: FakeRoute[] = [];

  /** Answers requests to `endpoint` whose params satisfy `match` with `body` (or `body(request)`). */
  on(endpoint: FdicEndpoint, match: (params: Params) => boolean, body: JsonBody | Responder): this {
    const respond: Responder = typeof body === 'function' ? body : () => structuredClone(body);
    this.#routes.push({ endpoint, match, respond });
    return this;
  }

  /** Requests sent to one endpoint, in order. */
  to(endpoint: FdicEndpoint): FakeRequest[] {
    return this.requests.filter((r) => r.endpoint === endpoint);
  }

  readonly getJson: GetJson = async (url, { signal }) => {
    const endpoint = url.pathname.replace(/^\/banks\//, '') as FdicEndpoint;
    const request: FakeRequest = {
      endpoint,
      params: Object.fromEntries(url.searchParams),
      signal,
      url,
    };
    this.requests.push(request);
    const route = this.#routes.find((r) => r.endpoint === endpoint && r.match(request.params));
    if (!route) throw internalError(`Unexpected FDIC request in test: ${url.toString()}`);
    return await route.respond(request);
  };
}

/** Installs a fresh `FdicService` over the fake as the handler-facing singleton. */
export function installFakeService(
  fake: FakeFdic,
  options: { cacheTtlSeconds?: number; now?: () => number; pacer?: Pacer } = {},
): FdicService {
  const service = new FdicService({
    getJson: fake.getJson,
    pacer: options.pacer ?? createPacer({ name: 'fdic-test' }),
    cacheTtlSeconds: options.cacheTtlSeconds ?? 3600,
    ...(options.now ? { now: options.now } : {}),
  });
  initFdicService(service);
  return service;
}

// ---------------------------------------------------------------------------
// Envelope builders (recorded BankFind response shapes)
// ---------------------------------------------------------------------------

/** `meta.index` per dataset — `data_as_of` must come from the dataset behind the primary rows. */
export const INDEX = {
  institutions: { name: 'institutions_20260924090002', createTimestamp: '2026-09-24T11:40:12Z' },
  financials: { name: 'risview_20260818170421', createTimestamp: '2026-08-18T17:04:23Z' },
  failures: { name: 'failures_1787580000000', createTimestamp: '2026-08-24T13:20:00Z' },
  sod: { name: 'sod_20260918102231', createTimestamp: '2026-09-18T10:22:35Z' },
} as const;

/** A search hit carrying a `highlight` block, as `/institutions` name searches return. */
export interface Hit {
  data: Record<string, unknown>;
  highlight: Record<string, string[]>;
}

export function hit(data: Record<string, unknown>, highlight: Record<string, string[]>): Hit {
  return { data, highlight };
}

function isHit(row: Record<string, unknown> | Hit): row is Hit {
  return 'highlight' in row && typeof row.data === 'object' && row.data !== null;
}

/**
 * `{ meta: { total, parameters, index }, data: [{ data, score, highlight? }], totals: { count, … } }`.
 * `total` defaults to the row count; `totals` adds `total_fields` sums or `subtotal_by_*` arrays.
 */
export function envelope(
  endpoint: FdicEndpoint,
  rows: ReadonlyArray<Record<string, unknown> | Hit>,
  options: { total?: number; totals?: Record<string, unknown> } = {},
) {
  const total = options.total ?? rows.length;
  return {
    meta: { total, parameters: {}, index: INDEX[endpoint] },
    data: rows.map((row) =>
      isHit(row)
        ? { data: { ...row.data }, score: 412.5, highlight: row.highlight }
        : { data: { ...row }, score: 0 },
    ),
    totals: { count: total, ...options.totals },
  };
}

export interface Bucket {
  count: number;
  key: string;
  /** Sums keyed by FDIC field (`COST`), emitted as `sum_<FIELD>`. */
  sums?: Record<string, number>;
}

/**
 * Aggregation response: `limit=0`, one `{ data: { <field>: key, count, sum_<F>… } }` row
 * per non-empty bucket in key order, `totals.sum_<F>` present only when something matched.
 */
export function aggEnvelope(
  endpoint: FdicEndpoint,
  field: string,
  buckets: readonly Bucket[],
  options: { total?: number } = {},
) {
  const total = options.total ?? buckets.reduce((n, b) => n + b.count, 0);
  const sumTotals: Record<string, number> = {};
  for (const bucket of buckets) {
    for (const [f, v] of Object.entries(bucket.sums ?? {})) {
      sumTotals[`sum_${f}`] = (sumTotals[`sum_${f}`] ?? 0) + v;
    }
  }
  return {
    meta: {
      total,
      parameters: { limit: '0', aggsMetaData: { by: field, limit: 10000 } },
      index: INDEX[endpoint],
    },
    data: buckets.map((b) => ({
      data: {
        [field]: b.key,
        count: b.count,
        ...Object.fromEntries(Object.entries(b.sums ?? {}).map(([f, v]) => [`sum_${f}`, v])),
      },
    })),
    totals: { count: total, ...(total > 0 ? sumTotals : {}) },
  };
}

/** The `count` quarter-ends ending at 2026-06-30 (the fakes' latest quarter), newest first, as `YYYYMMDD`. */
export function quarterEnds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const index = 2026 * 4 + 1 - i;
    return `${Math.floor(index / 4)}${['0331', '0630', '0930', '1231'][index % 4]}`;
  });
}

/**
 * The quarters (`YYYYMMDD` keys) a panel page request selects: the one named by
 * `REPDTE:"<q>"`, or every key within `REPDTE:[<a> TO <b>]`, newest first.
 */
export function requestedQuarters(filters: string | undefined, keys: readonly string[]): string[] {
  const one = /REPDTE:"(\d{8})"/.exec(filters ?? '')?.[1];
  const span = /REPDTE:\[(\d{8}) TO (\d{8})\]/.exec(filters ?? '');
  return keys
    .filter((key) =>
      one !== undefined
        ? key === one
        : span
          ? key >= (span[1] ?? '') && key <= (span[2] ?? '')
          : false,
    )
    .sort()
    .reverse();
}

/** FDIC's 400 body for a calendar-invalid date in a date-typed range. */
export const INVALID_DATE_400 = {
  errors: [
    {
      status: 400,
      links: {
        about: {
          href: 'https://pfabankapi.app.cloud.gov/docs',
          meta: { section: 'Filter Syntax' },
        },
      },
      title: 'Invalid request input, please double check your search query syntax',
      detail:
        "search_phase_execution_exception: [date_time_exception] Reason: date_time_exception: Invalid date 'FEBRUARY 30'",
      source: { parameter: 'filters' },
      meta: { timestamp: '2026-09-26T09:12:44.518Z' },
    },
  ],
};
