/**
 * @fileoverview Fake FDIC BankFind transport for tests. Implements the service's
 * `getJson` seam as a route table that records every URL it receives, plus
 * builders for the BankFind response envelope in its recorded shapes (row hits,
 * aggregation buckets, the 400 error body) across all five endpoints, recorded
 * `/history` rows, and the quarter matcher that panel page responders serve
 * single quarters and ranges by.
 * @module tests/helpers/fake-fdic
 */

import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { FdicService, type GetJson, initFdicService } from '@/services/fdic/fdic-service.js';

export type FdicEndpoint = 'institutions' | 'financials' | 'failures' | 'sod' | 'history';

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
  history: { name: 'history_20261023090007', createTimestamp: '2026-10-23T10:19:46Z' },
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
  /** `agg_term_fields=RESTYPE1` count columns, keyed by method code. */
  methods?: Record<string, number>;
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
    for (const [method, count] of Object.entries(bucket.methods ?? {})) {
      const key = `count_RESTYPE1_${method}`;
      sumTotals[key] = (sumTotals[key] ?? 0) + count;
    }
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
        ...Object.fromEntries(
          Object.entries(b.methods ?? {}).map(([method, count]) => [
            `count_RESTYPE1_${method}`,
            count,
          ]),
        ),
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

// ---------------------------------------------------------------------------
// /history rows (recorded from the live index, history_20261023090007)
// ---------------------------------------------------------------------------

/**
 * Institution-level `/history` rows. Each exit is recorded twice: an
 * outgoing-side row (211–225; `CERT` is the outgoing bank, or absent on 211 and
 * 224) and a survivor-side row (810–812; `CERT` is the survivor). Unpaired rows
 * are exits FDIC recorded on one side only.
 */
export const HISTORY = {
  /** SunTrust (867) merged into Truist (9846): the outgoing side. */
  truistMerger: {
    ID: '201911532_223_550_6300_550',
    TRANSNUM: 201911532,
    CERT: 867,
    CHANGECODE: 223,
    CHANGECODE_DESC: 'Merger -Without Assistance',
    EFFDATE: '2019-12-07T00:00:00',
    OUT_CERT: 867,
    OUT_INSTNAME: 'SunTrust Bank',
    SUR_CERT: 9846,
    SUR_INSTNAME: 'Truist Bank',
    ACQ_CERT: 9846,
    ACQ_INSTNAME: 'Branch Banking and Trust Company',
    PSTALP: 'NC',
    CLASS: 'NM',
    REGAGENT: 'FDIC',
    FRM_PSTALP: 'GA',
    FRM_CLASS: 'SM',
    FRM_REGAGENT: 'FED',
  },
  /** The same merger from Truist's side; its FRM_ fields describe SunTrust. */
  truistMergerSurvivor: {
    ID: '201911532_810_6300_6300_550',
    TRANSNUM: 201911532,
    CERT: 9846,
    CHANGECODE: 810,
    CHANGECODE_DESC: 'Participated in Absorbtion/Consolidation/Merger',
    EFFDATE: '2019-12-07T00:00:00',
    OUT_CERT: 867,
    OUT_INSTNAME: 'SunTrust Bank',
    SUR_CERT: 9846,
    SUR_INSTNAME: 'Truist Bank',
    ACQ_CERT: 9846,
    ACQ_INSTNAME: 'Branch Banking and Trust Company',
    PSTALP: 'NC',
    CLASS: 'NM',
    REGAGENT: 'FDIC',
    FRM_PSTALP: 'GA',
    FRM_CLASS: 'SM',
    FRM_REGAGENT: 'FED',
  },
  /** BB&T renamed Truist the same day; one transaction with the merger. */
  truistRename: {
    ID: '201911532_510_6300__',
    TRANSNUM: 201911532,
    CERT: 9846,
    CHANGECODE: 510,
    CHANGECODE_DESC: 'Change in Legal Name (FO or BR)',
    EFFDATE: '2019-12-07T00:00:00',
    INSTNAME: 'Truist Bank',
    FRM_INSTNAME: 'Branch Banking and Trust Company',
    FRM_CERT: 9846,
    PADDR: '214 N Tryon St',
    FRM_PADDR: '200 W 2nd St',
    PCITY: 'Charlotte',
    FRM_PCITY: 'Winston Salem',
    PSTALP: 'NC',
    FRM_PSTALP: 'NC',
    CLASS: 'NM',
    FRM_CLASS: 'NM',
    CHARTAGENT: 'STATE',
    FRM_CHARTAGENT: 'STATE',
    REGAGENT: 'FDIC',
    FRM_REGAGENT: 'FDIC',
  },
  /** Silicon Valley Bank (24735) failed: no CERT on the outgoing row. */
  svbFailure: {
    ID: '2023009929_211_17167_655043_17167',
    TRANSNUM: 2023009929,
    CHANGECODE: 211,
    CHANGECODE_DESC: 'Failure - Whole Institution',
    EFFDATE: '2023-03-10T00:00:00',
    OUT_CERT: 24735,
    OUT_INSTNAME: 'Silicon Valley Bank',
    SUR_CERT: 59331,
    SUR_INSTNAME: 'Deposit Insurance National Bank of Santa Clara',
    ACQ_CERT: 59331,
    ACQ_INSTNAME: 'Deposit Insurance National Bank of Santa Clara',
    PSTALP: 'CA',
    CLASS: 'N',
    REGAGENT: 'OCC',
    FRM_PSTALP: 'CA',
    FRM_CLASS: 'SM',
    FRM_REGAGENT: 'FED',
  },
  /** The bridge bank's side of the SVB failure. */
  svbFailureSurvivor: {
    ID: '2023009929_811_655043_655043_17167',
    TRANSNUM: 2023009929,
    CERT: 59331,
    CHANGECODE: 811,
    CHANGECODE_DESC: 'Participated in FDIC Assisted Merger',
    EFFDATE: '2023-03-10T00:00:00',
    OUT_CERT: 24735,
    OUT_INSTNAME: 'Silicon Valley Bank',
    SUR_CERT: 59331,
    SUR_INSTNAME: 'Deposit Insurance National Bank of Santa Clara',
    ACQ_CERT: 59331,
    ACQ_INSTNAME: 'Deposit Insurance National Bank of Santa Clara',
  },
  /** SVB's own relocation: a subject row whose address changed. */
  svbRelocation: {
    ID: '960011282_520_17167__',
    TRANSNUM: 960011282,
    CERT: 24735,
    CHANGECODE: 520,
    CHANGECODE_DESC: 'Change in Physical Location (FO or BR)',
    EFFDATE: '1995-08-04T00:00:00',
    INSTNAME: 'Silicon Valley Bank',
    FRM_INSTNAME: 'Silicon Valley Bank',
    FRM_CERT: 24735,
    PADDR: '3003 Tasman Drive',
    FRM_PADDR: '3000 Lakeside Drive',
    PCITY: 'Santa Clara',
    FRM_PCITY: 'Santa Clara',
    PSTALP: 'CA',
    FRM_PSTALP: 'CA',
    CLASS: 'SM',
    FRM_CLASS: 'SM',
    CHARTAGENT: 'STATE',
    FRM_CHARTAGENT: 'STATE',
    REGAGENT: 'FED',
    FRM_REGAGENT: 'FED',
  },
  /** First Republic (59017) failed into JPMorgan Chase (628): the outgoing side. */
  firstRepublicFailure: {
    ID: '2023160984_211_497251_417_497251',
    TRANSNUM: 2023160984,
    CHANGECODE: 211,
    CHANGECODE_DESC: 'Failure - Whole Institution',
    EFFDATE: '2023-05-01T00:00:00',
    OUT_CERT: 59017,
    OUT_INSTNAME: 'First Republic Bank',
    SUR_CERT: 628,
    SUR_INSTNAME: 'JPMorgan Chase Bank, National Association',
    ACQ_CERT: 628,
    ACQ_INSTNAME: 'JPMorgan Chase Bank, National Association',
  },
  /** JPMorgan Chase's side of the First Republic takeover. */
  firstRepublicSurvivor: {
    ID: '2023160984_811_417_417_497251',
    TRANSNUM: 2023160984,
    CERT: 628,
    CHANGECODE: 811,
    CHANGECODE_DESC: 'Participated in FDIC Assisted Merger',
    EFFDATE: '2023-05-01T00:00:00',
    OUT_CERT: 59017,
    OUT_INSTNAME: 'First Republic Bank',
    SUR_CERT: 628,
    SUR_INSTNAME: 'JPMorgan Chase Bank, National Association',
    ACQ_CERT: 628,
    ACQ_INSTNAME: 'JPMorgan Chase Bank, National Association',
  },
  /** JPMorgan Chase's 2008 assisted merger, recorded without an outgoing CERT. */
  assistedWithoutOutgoing: {
    ID: '200812274_811_417_417_45467',
    TRANSNUM: 200812274,
    CERT: 628,
    CHANGECODE: 811,
    CHANGECODE_DESC: 'Participated in FDIC Assisted Merger',
    EFFDATE: '2008-09-25T00:00:00',
    SUR_CERT: 628,
    SUR_INSTNAME: 'JPMorgan Chase Bank, National Association',
    ACQ_CERT: 628,
    ACQ_INSTNAME: 'JPMorgan Chase Bank, National Association',
  },
  /** An affiliated merger (224) into Bank of America (3510): no CERT on the outgoing row. */
  affiliatedMerger: {
    ID: '202003220_224_434076_2238_434076',
    TRANSNUM: 202003220,
    CHANGECODE: 224,
    CHANGECODE_DESC: 'Affiliated Institution Merger (Pooling) (i.e. Corporate Reorganization',
    EFFDATE: '2020-03-31T00:00:00',
    OUT_CERT: 58026,
    OUT_INSTNAME: 'Recontrust Company, National Association',
    SUR_CERT: 3510,
    SUR_INSTNAME: 'Bank of America, National Association',
    ACQ_CERT: 3510,
    ACQ_INSTNAME: 'Bank of America, National Association',
  },
  /** Bank of America's side of the affiliated merger. */
  affiliatedMergerSurvivor: {
    ID: '202003220_810_2238_2238_434076',
    TRANSNUM: 202003220,
    CERT: 3510,
    CHANGECODE: 810,
    CHANGECODE_DESC: 'Participated in Absorbtion/Consolidation/Merger',
    EFFDATE: '2020-03-31T00:00:00',
    OUT_CERT: 58026,
    OUT_INSTNAME: 'Recontrust Company, National Association',
    SUR_CERT: 3510,
    SUR_INSTNAME: 'Bank of America, National Association',
    ACQ_CERT: 3510,
    ACQ_INSTNAME: 'Bank of America, National Association',
  },
  /** 4827's exit, recorded only on the survivor's (4857) side. */
  survivorSideOnly: {
    ID: '730000137_810_3235_3235_3219',
    TRANSNUM: 730000137,
    CERT: 4857,
    CHANGECODE: 810,
    CHANGECODE_DESC: 'Participated in Absorbtion/Consolidation/Merger',
    EFFDATE: '1970-01-02T00:00:00',
    OUT_CERT: 4827,
    OUT_INSTNAME: 'The First National Bank of Barton',
    SUR_CERT: 4857,
    SUR_INSTNAME: 'The First National Bank of Oakland',
    ACQ_CERT: 4857,
    ACQ_INSTNAME: 'The First National Bank of Oakland',
  },
  /** 19442's merger into 19700, outgoing side; FDIC's 810 twin carries no `OUT_CERT`. */
  outgoingSideOnly: {
    ID: '910005375_223_13243_13499_13243',
    TRANSNUM: 910005375,
    CERT: 19442,
    CHANGECODE: 223,
    CHANGECODE_DESC: 'Merger -Without Assistance',
    EFFDATE: '1991-05-08T00:00:00',
    OUT_CERT: 19442,
    OUT_INSTNAME: 'Island State Bank',
    SUR_CERT: 19700,
    SUR_INSTNAME: 'The International Bank',
    ACQ_CERT: 19700,
    ACQ_INSTNAME: 'The International Bank',
  },
  /** SunTrust (867) bought branches of Omni National Bank. */
  branchPurchase: {
    ID: '201020269_712_550_550_15454',
    TRANSNUM: 201020269,
    CERT: 867,
    CHANGECODE: 712,
    CHANGECODE_DESC: 'Branch Purchased',
    EFFDATE: '2009-03-27T00:00:00',
    OUT_CERT: 22238,
    OUT_INSTNAME: 'Omni National Bank',
    ACQ_CERT: 867,
    ACQ_INSTNAME: 'SunTrust Bank',
    PSTALP: 'GA',
    CLASS: 'SM',
    REGAGENT: 'FED',
    FRM_PSTALP: 'GA',
    FRM_CLASS: 'N',
    FRM_REGAGENT: 'OCC',
  },
  /** FloridaFirst Bank (28838) bought branches of SunTrust (867). */
  branchSale: {
    ID: '200209235_712_41672_41672_550',
    TRANSNUM: 200209235,
    CERT: 28838,
    CHANGECODE: 712,
    CHANGECODE_DESC: 'Branch Purchased',
    EFFDATE: '2002-02-16T00:00:00',
    OUT_CERT: 867,
    OUT_INSTNAME: 'SunTrust Bank',
    ACQ_CERT: 28838,
    ACQ_INSTNAME: 'FloridaFirst Bank',
  },
  /** A certificate replaced by administrative order: 90054 became 20442. */
  certReplaced: {
    ID: '1971-06-17T00:00:00_150_14093__',
    TRANSNUM: 0,
    CERT: 20442,
    CHANGECODE: 150,
    CHANGECODE_DESC: 'Cert Changed from Old Cert by Administrative Order',
    EFFDATE: '1971-06-17T00:00:00',
    FRM_CERT: 90054,
    FRM_INSTNAME: 'Meriden Trust & Safe Deposit Company',
    INSTNAME: 'The Meriden Trust and Safe Deposit Company',
    PCITY: 'Meriden',
    FRM_PCITY: 'Meriden',
    PSTALP: 'CT',
    FRM_PSTALP: 'CT',
    CLASS: 'NM',
    FRM_CLASS: 'NC',
    CHARTAGENT: 'STATE',
    FRM_CHARTAGENT: 'STATE',
    REGAGENT: 'FDIC',
    FRM_REGAGENT: 'STATE',
  },
  /** A branch relocation of Wells Fargo (3511): the office's street address moved. */
  branchRelocation: {
    ID: '0a93314a4edc21c042f81965028a6af6',
    TRANSNUM: 2026028320,
    CERT: 3511,
    CHANGECODE: 520,
    CHANGECODE_DESC: 'Change in Physical Location (FO or BR)',
    EFFDATE: '2026-09-28T00:00:00',
    OFF_NAME: 'EAST FLAGLER STREET BRANCH',
    OFF_NUM: 7442,
    OFF_PADDR: '550 NW 1ST AVE',
    OFF_PCITY: 'MIAMI',
    OFF_PSTALP: 'FL',
    FRM_OFF_NAME: 'EAST FLAGLER STREET BRANCH',
    FRM_OFF_PADDR: '100 E FLAGLER ST',
    FRM_OFF_PCITY: 'MIAMI',
    FRM_OFF_PSTALP: 'FL',
  },
} as const satisfies Record<string, Record<string, unknown>>;

/** A branch-level row of `cert` on `date` (`YYYY-MM-DD`) with a unique `ID`, for paging fixtures. */
export function branchHistoryRow(cert: number, date: string, id: string): Record<string, unknown> {
  return {
    ID: id,
    TRANSNUM: 2026000000,
    CERT: cert,
    CHANGECODE: 711,
    CHANGECODE_DESC: 'Branch Opening',
    EFFDATE: `${date}T00:00:00`,
    OFF_NAME: `OFFICE ${id}`,
  };
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
