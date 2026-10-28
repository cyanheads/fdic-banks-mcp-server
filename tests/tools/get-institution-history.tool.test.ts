/**
 * @fileoverview Tests for fdic_get_institution_history over a faked FDIC transport:
 * the institution lookup and history read settled together, the default and
 * explicit event-type selections, local paging with next_offset, the zero-hit,
 * more-pages, and past-the-end notices, every declared error reason, the shared
 * deadline, cancellation, and both output surfaces.
 * @module tests/tools/get-institution-history.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstitutionHistoryTool } from '@/mcp-server/tools/definitions/get-institution-history.tool.js';
import { disposeFdicService, FdicService, initFdicService } from '@/services/fdic/fdic-service.js';
import { FAILED_BANK, HARBOR_BANK } from '../fixtures/fdic-records.js';
import {
  branchHistoryRow,
  envelope,
  FakeFdic,
  HISTORY,
  INDEX,
  installFakeService,
} from '../helpers/fake-fdic.js';
import {
  contractRecovery,
  readMarkdownText,
  structured,
  textOf,
  toolError,
} from '../helpers/tool-results.js';

type Output = z.infer<typeof getInstitutionHistoryTool.output> & {
  cap?: number;
  notice?: string;
  shown?: number;
  truncated?: boolean;
};
type Input = z.input<typeof getInstitutionHistoryTool.input>;

const tool = getInstitutionHistoryTool;
const DEFAULT_TYPES = [
  'merger',
  'failure_or_assistance',
  'branch_purchase',
  'name_change',
  'relocation',
  'charter_change',
  'opening',
  'closing',
  'other',
];

/** CERT 867's institution-level rows: its merger (both sides), a purchase, a sale, a rename. */
const SUNTRUST_ROWS = [
  HISTORY.truistMerger,
  HISTORY.truistMergerSurvivor,
  HISTORY.branchPurchase,
  HISTORY.branchSale,
  {
    ...HISTORY.truistRename,
    ID: '200001760_510_550__',
    TRANSNUM: 200001760,
    CERT: 867,
    EFFDATE: '2000-01-01T00:00:00',
    INSTNAME: 'SunTrust Bank',
    FRM_INSTNAME: 'SunTrust Bank, Atlanta',
    PADDR: '1 Park Place, N.E.',
    FRM_PADDR: '1 Park Place, N.E.',
    PCITY: 'Atlanta',
    FRM_PCITY: 'Atlanta',
  },
];

let fake: FakeFdic;

beforeEach(() => {
  fake = new FakeFdic();
  installFakeService(fake);
});

afterEach(() => {
  disposeFdicService();
  vi.useRealTimers();
});

/** The `/institutions` record for the CERT; `null` for a CERT with none. */
function withInstitution(record: Record<string, unknown> | null = HARBOR_BANK) {
  fake.on('institutions', () => true, envelope('institutions', record ? [record] : []));
}

function withHistory(rows: readonly Record<string, unknown>[]) {
  fake.on('history', (p) => p.filters?.includes('"FI"') ?? false, envelope('history', rows));
}

function withBranches(rows: readonly Record<string, unknown>[]) {
  fake.on('history', (p) => p.filters?.includes('"BR"') ?? false, envelope('history', rows));
}

/** FDIC's 429 with a wait longer than the call's budget, so the service gives up at once. */
function throttled(): never {
  throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '120' });
}

async function run(input: Input, signal?: AbortSignal) {
  const result = await runToolContract(tool, input, signal ? { context: { signal } } : undefined);
  return { result, text: textOf(result) };
}

describe('requests', () => {
  it('reads the institution record and the institution-level history, and no branch rows by default', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const { result } = await run({ cert: 867 });
    expect(fake.to('institutions')[0]?.params).toMatchObject({ filters: 'CERT:867', limit: '1' });
    expect(fake.to('history').map((r) => r.params.filters)).toEqual([
      'ORG_ROLE_CDE:"FI" AND (CERT:867 OR OUT_CERT:867 OR SUR_CERT:867)',
    ]);
    expect(structured<Output>(result).event_types_filter).toEqual(DEFAULT_TYPES);
  });

  it('deduplicates event_types, echoes them, and reads branch rows only when branch is named', async () => {
    withInstitution();
    withHistory([]);
    withBranches([{ ...HISTORY.branchRelocation, CERT: 867 }]);
    const { result } = await run({
      cert: 867,
      event_types: ['merger', 'branch', 'merger'],
      from_date: '2020-01-01',
    });
    const out = structured<Output>(result);
    expect(out.event_types_filter).toEqual(['merger', 'branch']);
    const filters = fake.to('history').map((r) => r.params.filters);
    expect(filters.sort()).toEqual([
      'CERT:867 AND ORG_ROLE_CDE:"BR" AND EFFDATE:[2020-01-01 TO *]',
      'ORG_ROLE_CDE:"FI" AND (CERT:867 OR OUT_CERT:867 OR SUR_CERT:867)',
    ]);
    expect(out.events.map((e) => [e.event_type, e.change_code])).toEqual([['branch', 520]]);
  });

  it('treats blank optional inputs from form clients as unset', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const { result } = await run({
      cert: 867,
      from_date: '',
      to_date: '  ',
      limit: '' as unknown as number,
      offset: '' as unknown as number,
    });
    const out = structured<Output>(result);
    expect(out.total).toBe(4);
    expect(out.events).toHaveLength(4);
    expect(out).not.toHaveProperty('next_offset');
  });

  it('runs branch history under the panel budget, one deadline for every page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    withInstitution();
    const page = [
      ...Array.from({ length: 9_000 }, (_, i) => branchHistoryRow(867, '2024-06-30', `a${i}`)),
      ...Array.from({ length: 1_000 }, (_, i) => branchHistoryRow(867, '2024-03-31', `b${i}`)),
    ];
    fake.on(
      'history',
      (p) => p.filters === 'CERT:867 AND ORG_ROLE_CDE:"BR"',
      () => {
        vi.setSystemTime(Date.now() + 40_000);
        return envelope('history', page, { total: 10_001 });
      },
    );
    withBranches([
      branchHistoryRow(867, '2024-03-31', 'b0'),
      branchHistoryRow(867, '2024-01-31', 'c'),
    ]);
    const timeouts: string[] = [];
    initFdicService(
      new FdicService({
        getJson: (url, opts) => {
          timeouts.push(`${url.pathname} ${opts.timeoutMs}`);
          return fake.getJson(url, opts);
        },
        pacer: createPacer({ name: 'fdic-test' }),
        cacheTtlSeconds: 0,
      }),
    );
    const { result } = await run({ cert: 867, event_types: ['branch'] });
    expect(structured<Output>(result).total).toBe(10_001);
    // 55 s budget: 40 s spent on the first page leaves 15 s; the 45 s default would leave 5.
    expect(timeouts).toEqual([
      '/banks/institutions 30000',
      '/banks/history 30000',
      '/banks/history 15000',
    ]);
  });
});

describe('events', () => {
  it('returns one event per exit, newest first, with role and counterparty, through the output schema', async () => {
    withInstitution({ ...FAILED_BANK, CERT: 867, NAME: 'SunTrust Bank', NEWCERT: 9846 });
    withHistory(SUNTRUST_ROWS);
    const { result } = await run({ cert: 867 });
    const out = tool.output.parse(structured(result));
    expect(out.events).toEqual([
      {
        effective_date: '2019-12-07',
        event_type: 'merger',
        change_code: 223,
        change_description: 'Merger -Without Assistance',
        role: 'outgoing',
        counterparty: { cert: 9846, name: 'Truist Bank' },
        transaction_number: 201911532,
      },
      {
        effective_date: '2009-03-27',
        event_type: 'branch_purchase',
        change_code: 712,
        change_description: 'Branch Purchased',
        role: 'buyer',
        counterparty: { cert: 22238, name: 'Omni National Bank' },
        transaction_number: 201020269,
      },
      {
        effective_date: '2002-02-16',
        event_type: 'branch_purchase',
        change_code: 712,
        change_description: 'Branch Purchased',
        role: 'seller',
        counterparty: { cert: 28838, name: 'FloridaFirst Bank' },
        transaction_number: 200209235,
      },
      {
        effective_date: '2000-01-01',
        event_type: 'name_change',
        change_code: 510,
        change_description: 'Change in Legal Name (FO or BR)',
        role: 'subject',
        changes: { name: { from: 'SunTrust Bank, Atlanta', to: 'SunTrust Bank' } },
        transaction_number: 200001760,
      },
    ]);
    expect(out.institution).toMatchObject({
      cert: 867,
      name: 'SunTrust Bank',
      active: false,
      successor_cert: 9846,
    });
    expect(out.total).toBe(4);
    expect(out).not.toHaveProperty('next_offset');
    expect(out.data_as_of).toBe(INDEX.history.createTimestamp);
  });

  it('narrows to the asked-for types after pairing (a failure stays a failure)', async () => {
    withInstitution();
    withHistory([HISTORY.svbFailure, HISTORY.svbFailureSurvivor, HISTORY.svbRelocation]);
    const failures = structured<Output>((await run({ cert: 24735 })).result);
    expect(failures.events[0]).toMatchObject({
      event_type: 'failure_or_assistance',
      change_code: 211,
      role: 'outgoing',
      counterparty: { cert: 59331 },
    });
    expect(failures.total).toBe(2);
    const relocations = structured<Output>(
      (await run({ cert: 24735, event_types: ['relocation'] })).result,
    );
    expect(relocations.events.map((e) => e.event_type)).toEqual(['relocation']);
  });

  it('filters institution events by effective date, inclusive at both ends', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const out = structured<Output>(
      (await run({ cert: 867, from_date: '2002-02-16', to_date: '2009-03-27' })).result,
    );
    expect(out.events.map((e) => e.effective_date)).toEqual(['2009-03-27', '2002-02-16']);
  });
});

describe('paging', () => {
  it('walks offset/next_offset to every event once, with the notice on each page that has more', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const seen: string[] = [];
    let offset: number | undefined = 0;
    const notices: (string | undefined)[] = [];
    while (offset !== undefined) {
      const out: Output = structured<Output>((await run({ cert: 867, limit: 3, offset })).result);
      seen.push(...out.events.map((e) => `${e.effective_date} ${e.change_code} ${e.role}`));
      notices.push(out.notice);
      offset = out.next_offset;
    }
    expect(seen).toEqual([
      '2019-12-07 223 outgoing',
      '2009-03-27 712 buyer',
      '2002-02-16 712 seller',
      '2000-01-01 510 subject',
    ]);
    expect(notices).toEqual([
      'Showing events 1–3 of 4, newest first; pass offset 3 for the next page.',
      undefined,
    ]);
  });

  it('discloses a capped page on both surfaces', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const { result, text } = await run({ cert: 867, limit: 1, offset: 1 });
    expect(structured<Output>(result)).toMatchObject({
      next_offset: 2,
      truncated: true,
      shown: 1,
      cap: 1,
      notice: 'Showing events 2–2 of 4, newest first; pass offset 2 for the next page.',
    });
    expect(readMarkdownText(text)).toContain(
      'Showing events 2–2 of 4, newest first; pass offset 2 for the next page.',
    );
    expect(text).toContain('Next page: offset 2.');
  });

  it('returns every event with no next_offset when limit exceeds the count', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const out = structured<Output>((await run({ cert: 867, limit: 1_000_000 })).result);
    expect(out.events).toHaveLength(4);
    expect(out).not.toHaveProperty('next_offset');
    expect(out).not.toHaveProperty('notice');
  });

  it('returns an empty page with its notice when offset is past the end', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const { result, text } = await run({ cert: 867, offset: 4 });
    const out = structured<Output>(result);
    expect(out.events).toEqual([]);
    expect(out.total).toBe(4);
    expect(out.notice).toBe('offset 4 is past the last of 4 events; lower offset or omit it.');
    expect(readMarkdownText(text)).toContain(
      'offset 4 is past the last of 4 events; lower offset or omit it.',
    );
  });
});

describe('zero-event notices', () => {
  it('says branch events were left out when the default selection found nothing', async () => {
    withInstitution();
    withHistory([]);
    const out = structured<Output>((await run({ cert: 90709 })).result);
    expect(out.total).toBe(0);
    expect(out.notice).toBe(
      'No events for CERT 90709. Branch events are left out by default; add branch to event_types to include them.',
    );
  });

  it('names the explicit types and the date window when they found nothing', async () => {
    withInstitution();
    withHistory(SUNTRUST_ROWS);
    const out = structured<Output>(
      (await run({ cert: 867, event_types: ['merger', 'closing'], to_date: '1999-12-31' })).result,
    );
    expect(out.events).toEqual([]);
    expect(out.notice).toBe(
      "No events for CERT 867. Only merger, closing events were searched; omit event_types for every type but branch. Dates match each event's effective date; widen from_date/to_date or omit them.",
    );
  });
});

describe('errors', () => {
  it('fails cert_not_found for a CERT without an institution record, on both surfaces', async () => {
    withInstitution(null);
    withHistory([HISTORY.truistMerger]);
    const { result, text } = await run({ cert: 99_999_999 });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'cert_not_found',
        recovery: { hint: contractRecovery(tool, 'cert_not_found') },
      },
    });
    expect(readMarkdownText(text)).toContain('No FDIC institution record carries CERT 99999999.');
    expect(readMarkdownText(text)).toContain(contractRecovery(tool, 'cert_not_found'));
  });

  it('fails cert_not_found, not the rate limit, when the history read is throttled for an unknown CERT', async () => {
    withInstitution(null);
    fake.on('history', () => true, throttled);
    const { result } = await run({ cert: 99_999_999 });
    expect(toolError(result).data?.reason).toBe('cert_not_found');
  });

  it('surfaces a throttled history read for a known CERT as upstream_rate_limited with the wait', async () => {
    withInstitution();
    fake.on('history', () => true, throttled);
    const { result, text } = await run({ cert: 867 });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'upstream_rate_limited', retryAfter: 120 },
    });
    expect(text).toContain('wait 120 seconds');
  });

  it.each<[string, Input, string, string]>([
    [
      'a day its month lacks',
      { cert: 867, from_date: '2023-02-30' },
      'invalid_date',
      '2023-02-30 is not a real calendar date.',
    ],
    [
      'from_date after to_date',
      { cert: 867, from_date: '2024-01-01', to_date: '2023-01-01' },
      'invalid_date_range',
      'from_date 2024-01-01 is after to_date 2023-01-01.',
    ],
  ])('fails %s as %s before any request', async (_label, input, reason, message) => {
    const { result, text } = await run(input);
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message,
      data: { reason, recovery: { hint: contractRecovery(tool, reason) } },
    });
    expect(readMarkdownText(text)).toContain(message);
    expect(fake.requests).toEqual([]);
  });

  it('rejects an empty event_types and a zero limit at the schema', () => {
    expect(tool.input.safeParse({ cert: 867, event_types: [] }).success).toBe(false);
    expect(tool.input.safeParse({ cert: 867, limit: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ cert: 867, event_types: ['MERGER'] }).success).toBe(false);
  });

  it('reports a call cancelled while a history page is in flight as cancelled, not as a result', async () => {
    const controller = new AbortController();
    withInstitution();
    fake.on(
      'history',
      () => true,
      () => {
        controller.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    );
    const { result } = await run({ cert: 867 }, controller.signal);
    expect(toolError(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(result.structuredContent).not.toHaveProperty('events');
  });
});

describe('format', () => {
  it('renders the identity line and one table row per event, with every field', async () => {
    withInstitution({
      ...FAILED_BANK,
      CERT: 867,
      NAME: 'SunTrust Bank',
      CITY: 'Atlanta',
      STALP: 'GA',
      NEWCERT: 9846,
    });
    withHistory(SUNTRUST_ROWS);
    const { text } = await run({ cert: 867, limit: 4 });
    const lines = text.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      '## SunTrust Bank — CERT 867',
      'Inactive · Atlanta, GA · ended 2023-03-10 · successor CERT 9846',
      `4 events of types ${DEFAULT_TYPES.join(', ')}; 4 shown, newest first. Data as of ${INDEX.history.createTimestamp}.`,
    ]);
    expect(lines).toContain(
      '| Date | Type | Code | Description | Role | Counterparty | Changes or branch | Transaction |',
    );
    expect(lines).toContain(
      '| 2019-12-07 | merger | 223 | Merger -Without Assistance | outgoing | Truist Bank · CERT 9846 | — | 201911532 |',
    );
    expect(lines).toContain(
      '| 2000-01-01 | name_change | 510 | Change in Legal Name (FO or BR) | subject | — | name: SunTrust Bank, Atlanta → SunTrust Bank | 200001760 |',
    );
  });

  it('renders branch detail and upstream text literally inside table cells', async () => {
    withInstitution();
    withHistory([]);
    withBranches([
      {
        ...HISTORY.branchRelocation,
        CERT: 867,
        TRANSNUM: 0,
        OFF_NAME: 'MAIN | *STAR* BRANCH',
        CHANGECODE_DESC: 'Change in Physical Location (FO or BR)',
      },
    ]);
    const { result, text } = await run({ cert: 867, event_types: ['branch'] });
    expect(structured<Output>(result).events[0]?.branch?.name).toBe('MAIN | *STAR* BRANCH');
    expect(text.split('\n')).toContain(
      '| 2026-09-28 | branch | 520 | Change in Physical Location (FO or BR) | subject | — | branch: office 7442, MAIN \\| \\*STAR\\* BRANCH, 550 NW 1ST AVE, MIAMI, FL; name: EAST FLAGLER STREET BRANCH → MAIN \\| \\*STAR\\* BRANCH; address: 100 E FLAGLER ST → 550 NW 1ST AVE | — |',
    );
    expect(text).toContain('1 event of types branch; 1 shown');
  });
});
