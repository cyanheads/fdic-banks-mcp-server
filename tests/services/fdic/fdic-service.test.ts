/**
 * @fileoverview Tests for the FdicService request pipeline — canonical URLs, the
 * TTL cache on an injected clock, in-flight dedupe, envelope validation, and the
 * error mapping (400 → InternalError, 429 → upstream_rate_limited, pacer shed →
 * pacer_shed). The FDIC boundary is faked at the `getJson` seam; the default
 * transport is exercised through a faked `fetch` so `fetchWithTimeout` runs for real.
 * @module tests/services/fdic/fdic-service.test
 */

import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchInstitutionsTool } from '@/mcp-server/tools/definitions/search-institutions.tool.js';
import {
  callBudget,
  createFetchJson,
  disposeFdicService,
  FdicService,
  getFdicService,
  initFdicService,
} from '@/services/fdic/fdic-service.js';
import { HARBOR_BANK } from '../../fixtures/fdic-records.js';
import { envelope, FakeFdic, INDEX, INVALID_DATE_400 } from '../../helpers/fake-fdic.js';

/** A context carrying a data tool's contract, so rewrapped errors get its recovery text. */
function toolCtx(signal?: AbortSignal) {
  return createMockContext({
    errors: searchInstitutionsTool.errors,
    ...(signal ? { signal } : {}),
  });
}

function serviceOver(
  fake: FakeFdic,
  options: { cacheTtlSeconds?: number; now?: () => number } = {},
) {
  return new FdicService({
    getJson: fake.getJson,
    pacer: createPacer({ name: 'fdic-test' }),
    cacheTtlSeconds: options.cacheTtlSeconds ?? 3600,
    ...(options.now ? { now: options.now } : {}),
  });
}

const CERT_QUERY = { filters: 'CERT:57701', fields: 'CERT,NAME', limit: 1 };

async function caught(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof McpError)) throw new Error(`Expected an McpError, got ${String(error)}`);
  return error;
}

/** Settles a promise while draining the retry backoff timers under fake timers. */
async function settleThroughBackoff(promise: Promise<unknown>): Promise<McpError> {
  const settled = caught(promise);
  await vi.runAllTimersAsync();
  return settled;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('request URLs', () => {
  it('builds a canonical URL: base path, params sorted, undefined dropped, values encoded', async () => {
    const fake = new FakeFdic().on('institutions', () => true, envelope('institutions', []));
    const service = serviceOver(fake);
    await service.query(
      'institutions',
      { search: 'NAME:Farmers & Merchants', limit: 5, offset: undefined, fields: 'CERT,NAME' },
      toolCtx(),
      callBudget(),
    );
    expect(fake.requests[0]?.url.toString()).toBe(
      'https://api.fdic.gov/banks/institutions?fields=CERT%2CNAME&limit=5&search=NAME%3AFarmers%20%26%20Merchants',
    );
  });

  it('surfaces meta.total, meta.index.createTimestamp, rows with highlights, and the totals block', async () => {
    const body = envelope('institutions', [HARBOR_BANK], { total: 7, totals: { ASSET: 12 } });
    body.data[0] = { ...body.data[0]!, highlight: { 'NAME.raw': ['<em>Harbor</em>'] } };
    const fake = new FakeFdic().on('institutions', () => true, body);
    const result = await serviceOver(fake).query(
      'institutions',
      CERT_QUERY,
      toolCtx(),
      callBudget(),
    );
    expect(result.total).toBe(7);
    expect(result.dataAsOf).toBe(INDEX.institutions.createTimestamp);
    expect(result.rows[0]).toEqual({
      data: HARBOR_BANK,
      highlight: { 'NAME.raw': ['<em>Harbor</em>'] },
    });
    expect(result.totals).toEqual({ count: 7, ASSET: 12 });
  });
});

describe('response cache', () => {
  it('serves an identical request from cache until the TTL elapses on the injected clock', async () => {
    let now = 1_000_000;
    const fake = new FakeFdic().on('institutions', () => true, envelope('institutions', []));
    const service = serviceOver(fake, { cacheTtlSeconds: 60, now: () => now });

    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    now += 59_999;
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    expect(fake.requests).toHaveLength(1);

    now += 1;
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    expect(fake.requests).toHaveLength(2);
  });

  it('keys the cache on the canonical URL, so parameter order does not matter', async () => {
    const fake = new FakeFdic().on('institutions', () => true, envelope('institutions', []));
    const service = serviceOver(fake);
    await service.query(
      'institutions',
      { limit: 1, fields: 'CERT', filters: 'CERT:1' },
      toolCtx(),
      callBudget(),
    );
    await service.query(
      'institutions',
      { filters: 'CERT:1', fields: 'CERT', limit: 1 },
      toolCtx(),
      callBudget(),
    );
    expect(fake.requests).toHaveLength(1);
  });

  it('caches nothing when the TTL is 0', async () => {
    const fake = new FakeFdic().on('institutions', () => true, envelope('institutions', []));
    const service = serviceOver(fake, { cacheTtlSeconds: 0 });
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    expect(fake.requests).toHaveLength(2);
  });

  it('does not cache a single response over 8 MB', async () => {
    const filler = 'x'.repeat(1_000);
    const rows = Array.from({ length: 8_600 }, (_, i) => ({
      CERT: i + 1,
      NAME: filler,
      ID: String(i + 1),
    }));
    const big = envelope('institutions', rows);
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      () => big,
    );
    const service = serviceOver(fake);
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    expect(JSON.stringify(big).length).toBeGreaterThan(8 * 1024 * 1024);
    expect(fake.requests).toHaveLength(2);
  });

  it('does not cache a failed response', async () => {
    let calls = 0;
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      () => (++calls === 1 ? INVALID_DATE_400 : envelope('institutions', [HARBOR_BANK])),
    );
    const service = serviceOver(fake);
    await expect(
      service.query('institutions', CERT_QUERY, toolCtx(), callBudget()),
    ).rejects.toThrow();
    const second = await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    expect(second.rows).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
  });
});

describe('in-flight dedupe', () => {
  it('shares one upstream call between concurrent identical requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      async () => {
        await gate;
        return envelope('institutions', [HARBOR_BANK]);
      },
    );
    const service = serviceOver(fake, { cacheTtlSeconds: 0 });
    const first = service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    const second = service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(fake.requests).toHaveLength(1);
    expect(b).toBe(a);
  });

  it('lets a live caller issue its own request when the originating caller cancels', async () => {
    let calls = 0;
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      (request) => {
        calls++;
        if (calls > 1) return envelope('institutions', [HARBOR_BANK]);
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
    );
    const service = serviceOver(fake, { cacheTtlSeconds: 0 });
    const originator = new AbortController();
    const cancelled = service.query(
      'institutions',
      CERT_QUERY,
      toolCtx(originator.signal),
      callBudget(),
    );
    const live = service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    originator.abort(new DOMException('caller went away', 'AbortError'));

    await expect(cancelled).rejects.toThrow('caller went away');
    const result = await live;
    expect(result.rows).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
  });
});

describe('envelope validation', () => {
  it('reports an FDIC error envelope on a 200 as this server’s query fault, without retrying', async () => {
    const fake = new FakeFdic().on('failures', () => true, INVALID_DATE_400);
    const error = await caught(
      serviceOver(fake).query('failures', { filters: 'x' }, toolCtx(), callBudget()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data).toMatchObject({
      status: 400,
      parameter: 'filters',
      detail: expect.stringContaining("Invalid date 'FEBRUARY 30'"),
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('retries a body without the meta block as ServiceUnavailable, then surfaces it', async () => {
    vi.useFakeTimers();
    const fake = new FakeFdic().on('financials', () => true, { data: [] });
    const error = await settleThroughBackoff(
      serviceOver(fake).query('financials', { limit: 1 }, toolCtx(), callBudget()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/expected meta and data/);
    expect(fake.requests).toHaveLength(3);
  });
});

describe('error mapping', () => {
  it('rewraps a transport 400 carrying FDIC’s error body as InternalError with its detail', async () => {
    const fake = new FakeFdic().on(
      'failures',
      () => true,
      () => {
        throw new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
          status: 400,
          body: JSON.stringify(INVALID_DATE_400),
          retryable: false,
        });
      },
    );
    const error = await caught(
      serviceOver(fake).query('failures', { filters: 'x' }, toolCtx(), callBudget()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toMatch(/^FDIC rejected a query this server built: /);
    expect(error.data).toMatchObject({ status: 400, parameter: 'filters' });
    expect(fake.requests).toHaveLength(1);
  });

  it('fails fast on a 429 whose Retry-After exceeds the retry budget, as upstream_rate_limited', async () => {
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      () => {
        throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '30' });
      },
    );
    const error = await caught(
      serviceOver(fake).query('institutions', CERT_QUERY, toolCtx(), callBudget()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toEqual({
      reason: 'upstream_rate_limited',
      retryAfter: 30,
      retryable: true,
      recovery: {
        hint: 'FDIC is throttling requests; wait retryAfter seconds before calling again, and send fewer, narrower calls.',
      },
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('retries a 429 without Retry-After, then reports a 5 s retryAfter', async () => {
    vi.useFakeTimers();
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      () => {
        throw rateLimited('Fetch failed. Status: 429', { status: 429 });
      },
    );
    const error = await settleThroughBackoff(
      serviceOver(fake).query('institutions', CERT_QUERY, toolCtx(), callBudget()),
    );
    expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: 5 });
    expect(fake.requests).toHaveLength(3);
  });

  it('retries a 429 after the Retry-After wait FDIC named and returns the recovered response', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fake = new FakeFdic().on(
      'institutions',
      () => true,
      () => {
        if (++calls === 1) {
          throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '2' });
        }
        return envelope('institutions', [HARBOR_BANK]);
      },
    );
    const pending = serviceOver(fake).query('institutions', CERT_QUERY, toolCtx(), callBudget());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ total: 1 });
    expect(fake.requests).toHaveLength(2);
  });

  it('closes the shared pacer gate after a 429 so queued callers wait out the cooldown', async () => {
    vi.useFakeTimers();
    const pacer = createPacer({ name: 'fdic-cooldown', cooldown: { baseMs: 50, maxMs: 200 } });
    const fake = new FakeFdic()
      .on(
        'institutions',
        (p) => p.filters === 'CERT:1',
        () => {
          throw rateLimited('Fetch failed. Status: 429', { status: 429, retryAfter: '60' });
        },
      )
      .on('institutions', () => true, envelope('institutions', []));
    const service = new FdicService({ getJson: fake.getJson, pacer, cacheTtlSeconds: 0 });

    await caught(service.query('institutions', { filters: 'CERT:1' }, toolCtx(), callBudget()));
    const next = service.query('institutions', { filters: 'CERT:2' }, toolCtx(), callBudget());
    await vi.advanceTimersByTimeAsync(199);
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fake.requests).toHaveLength(2);
    pacer.dispose();
  });

  it('rewraps a pacer shed as pacer_shed with retryAfter and the tool’s recovery text', async () => {
    const pacer = createPacer({ name: 'fdic-shed', limits: [{ requests: 1, perMs: 60_000 }] });
    await pacer.run(async () => undefined);
    const fake = new FakeFdic().on('institutions', () => true, envelope('institutions', []));
    const service = new FdicService({ getJson: fake.getJson, pacer, cacheTtlSeconds: 0 });

    const error = await caught(service.query('institutions', CERT_QUERY, toolCtx(), callBudget()));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'pacer_shed',
      retryable: true,
      recovery: {
        hint: 'The shared FDIC request budget is busy; wait retryAfter seconds and call again, or narrow the request to fewer quarters or institutions.',
      },
    });
    expect(error.data?.retryAfter).toBeGreaterThan(50);
    expect(fake.requests).toHaveLength(0);
    pacer.dispose();
  });
});

describe('typed query methods', () => {
  it('reads the latest published quarter as an ISO date', async () => {
    const fake = new FakeFdic().on(
      'financials',
      (p) => p.fields === 'REPDTE',
      envelope('financials', [{ REPDTE: '20260630', ID: '628_20260630' }], { total: 1680000 }),
    );
    const latest = await serviceOver(fake).latestReportDate(toolCtx(), callBudget());
    expect(latest).toEqual({
      reportDate: '2026-06-30',
      dataAsOf: INDEX.financials.createTimestamp,
    });
    expect(fake.requests[0]?.params).toEqual({
      fields: 'REPDTE',
      sort_by: 'REPDTE',
      sort_order: 'DESC',
      limit: '1',
    });
  });

  it('fails as ServiceUnavailable when FDIC returns no report dates at all', async () => {
    const fake = new FakeFdic().on('financials', () => true, envelope('financials', []));
    const error = await caught(serviceOver(fake).latestReportDate(toolCtx(), callBudget()));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('reads the latest failure date from M/D/YYYY', async () => {
    const fake = new FakeFdic().on(
      'failures',
      () => true,
      envelope('failures', [{ FAILDATE: '7/17/2026', ID: '4200' }], { total: 4117 }),
    );
    await expect(serviceOver(fake).latestFailureDate(toolCtx(), callBudget())).resolves.toBe(
      '2026-07-17',
    );
  });
});

describe('default transport', () => {
  const FDIC = 'https://api.fdic.gov';
  const onPath = (path: string) => (req: Request) => {
    const url = new URL(req.url);
    return url.origin === FDIC && url.pathname === path;
  };

  it('sends the server User-Agent and Accept headers and parses the JSON body', async () => {
    const http = createFetchMock([
      {
        match: onPath('/banks/institutions'),
        respond: Response.json(envelope('institutions', [HARBOR_BANK])),
      },
    ]);
    http.install();
    try {
      const service = new FdicService({
        pacer: createPacer({ name: 'fdic-test' }),
        cacheTtlSeconds: 0,
      });
      const result = await service.query('institutions', CERT_QUERY, toolCtx(), callBudget());
      expect(result.rows[0]?.data.CERT).toBe(57701);
      const headers = http.calls[0]?.request.headers;
      expect(headers?.get('user-agent')).toMatch(
        /^fdic-banks-mcp-server\/\S+ \(\+https:\/\/github\.com\/cyanheads\/fdic-banks-mcp-server\)$/,
      );
      expect(headers?.get('accept')).toBe('application/json');
    } finally {
      http.restore();
    }
  });

  it('turns an FDIC 400 into InternalError carrying FDIC’s detail and parameter', async () => {
    const http = createFetchMock([
      {
        match: onPath('/banks/failures'),
        respond: Response.json(INVALID_DATE_400, { status: 400 }),
      },
    ]);
    http.install();
    try {
      const service = new FdicService({
        pacer: createPacer({ name: 'fdic-test' }),
        cacheTtlSeconds: 0,
      });
      const error = await caught(
        service.query(
          'failures',
          { filters: 'FAILDATE:[2023-02-30 TO *]' },
          toolCtx(),
          callBudget(),
        ),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data).toMatchObject({
        status: 400,
        parameter: 'filters',
        detail: expect.stringContaining("Invalid date 'FEBRUARY 30'"),
      });
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('turns an FDIC 429 with Retry-After into upstream_rate_limited carrying that wait', async () => {
    const http = createFetchMock([
      {
        match: onPath('/banks/financials'),
        respond: new Response('{"message":"rate limited"}', {
          status: 429,
          headers: { 'Retry-After': '30', 'content-type': 'application/json' },
        }),
      },
    ]);
    http.install();
    try {
      const service = new FdicService({
        pacer: createPacer({ name: 'fdic-test' }),
        cacheTtlSeconds: 0,
      });
      const error = await caught(
        service.query('financials', { limit: 1 }, toolCtx(), callBudget()),
      );
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'upstream_rate_limited', retryAfter: 30 });
    } finally {
      http.restore();
    }
  });

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><body>Gateway</body></html>', /HTML instead of JSON/],
    ['unparsable JSON', '{"meta": {', /not valid JSON/],
  ])('reports a 200 carrying %s as ServiceUnavailable', async (_label, body, message) => {
    const http = createFetchMock([
      { match: onPath('/banks/failures'), respond: new Response(body) },
    ]);
    http.install();
    try {
      const getJson = createFetchJson('fdic-banks-mcp-server/test');
      const error = await caught(
        getJson(new URL(`${FDIC}/banks/failures?limit=1`), {
          signal: new AbortController().signal,
          timeoutMs: 5_000,
          context: toolCtx(),
        }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toMatch(message);
    } finally {
      http.restore();
    }
  });
});

describe('service accessor', () => {
  it('throws before initialization in a fresh module', async () => {
    vi.resetModules();
    const fresh = await import('@/services/fdic/fdic-service.js');
    expect(() => fresh.getFdicService()).toThrow(/not initialized/);
  });

  it('returns the installed service and forgets it on dispose', () => {
    const service = serviceOver(new FakeFdic());
    initFdicService(service);
    expect(getFdicService()).toBe(service);
    disposeFdicService();
    expect(() => getFdicService()).toThrow(/not initialized/);
  });
});
