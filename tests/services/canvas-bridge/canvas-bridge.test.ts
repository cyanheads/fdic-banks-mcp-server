/**
 * @fileoverview Tests for CanvasBridge over a real in-memory DuckDB DataCanvas:
 * staging under minted df_ names with provenance kept in ctx.state, one shared
 * canvas per tenant, describe ordering and paging, SQL through the read-only
 * gate with framework rejections rethrown under fdic_dataframe_query's contract
 * reasons and recovery, register_as provenance, drop, the lazy TTL sweep,
 * canvas expiry, staging failure and cancellation, and tenant isolation.
 * @module tests/services/canvas-bridge/canvas-bridge.test
 */

import type { ColumnSchema, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  CanvasBridge,
  getCanvasBridge,
  initCanvasBridge,
  type StageOptions,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas, tenantSession } from '../../helpers/canvas.js';
import { contractRecovery } from '../../helpers/tool-results.js';

const DAY_MS = 86_400_000;
const T0 = new Date('2026-09-26T12:00:00.000Z');
const TABLE_NAME = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;

/** A ratio column that opens with 0 — the case schema sniffing would read as an integer. */
const PANEL_SCHEMA: ColumnSchema[] = [
  { name: 'cert', type: 'INTEGER' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'report_date', type: 'DATE' },
  { name: 'roa', type: 'DOUBLE' },
];

const PANEL_ROWS = [
  { cert: 57701, name: 'EVERGREEN HARBOR BK', report_date: '2026-06-30', roa: 0 },
  { cert: 33990, name: 'CEDAR FLATS CMNTY BK', report_date: '2026-06-30', roa: 1.16 },
  { cert: 24900, name: 'SUMMIT VALLEY BK', report_date: '2026-03-31', roa: null },
];

function stageOptions(overrides: Partial<StageOptions> = {}): StageOptions {
  return {
    sourceTool: 'fdic_query_financials',
    queryParams: { state: 'wa', limit: 2 },
    rows: PANEL_ROWS,
    schema: PANEL_SCHEMA,
    ...overrides,
  };
}

let canvas: DataCanvas;
let bridge: CanvasBridge;
let session: ReturnType<typeof tenantSession>;

/** A request context carrying fdic_dataframe_query's contract, on the session's state. */
const queryCtx = () => session({ errors: dataframeQueryTool.errors });

function useCanvas(options: { canvasTtlMs?: number } = {}) {
  canvas = createDuckdbCanvas(options);
  bridge = new CanvasBridge(canvas);
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof McpError)) throw new Error(`Expected an McpError, got ${String(error)}`);
  return error;
}

/** Table names on the tenant's current canvas, read from DuckDB itself. */
async function canvasTables(): Promise<string[]> {
  const ctx = queryCtx();
  const id = await ctx.state.get<string>('canvas-id');
  if (!id) return [];
  const instance = await canvas.acquire(id, ctx);
  return (await instance.describe()).map((t) => t.name);
}

beforeEach(() => {
  session = tenantSession();
  useCanvas();
});

afterEach(async () => {
  vi.useRealTimers();
  await canvas.shutdown(createMockContext());
});

describe('stage', () => {
  it('registers rows under a minted df_ name on the shared canvas and records provenance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const ctx = session();
    const dataset = await bridge.stage(
      ctx,
      stageOptions({
        columnUnits: { roa: { unit: 'percent', basis: 'quarter_annualized' } },
        truncated: true,
        maxRows: 50_000,
      }),
    );

    expect(dataset?.name).toMatch(TABLE_NAME);
    expect(dataset).toEqual({
      name: dataset?.name,
      row_count: 3,
      expires_at: new Date(T0.getTime() + DAY_MS).toISOString(),
    });
    expect(await ctx.state.get('canvas-id')).toEqual(expect.any(String));
    expect(await bridge.describe(ctx)).toEqual([
      {
        tableName: dataset?.name,
        sourceTool: 'fdic_query_financials',
        queryParams: { state: 'wa', limit: 2 },
        createdAt: T0.toISOString(),
        expiresAt: new Date(T0.getTime() + DAY_MS).toISOString(),
        rowCount: 3,
        truncated: true,
        maxRows: 50_000,
        columnSchema: PANEL_SCHEMA,
        columnUnits: { roa: { unit: 'percent', basis: 'quarter_annualized' } },
      },
    ]);
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'Dataframe staged' }),
    );
  });

  it('keeps fractional values in a DOUBLE column that opens with 0, and DATE columns as ISO dates', async () => {
    const dataset = await bridge.stage(session(), stageOptions());
    const { result } = await bridge.query(
      queryCtx(),
      `SELECT cert, report_date, roa FROM ${dataset?.name} ORDER BY cert`,
      { rowLimit: 10 },
    );
    expect(result.rows).toEqual([
      { cert: 24900, report_date: '2026-03-31', roa: null },
      { cert: 33990, report_date: '2026-06-30', roa: 1.16 },
      { cert: 57701, report_date: '2026-06-30', roa: 0 },
    ]);
  });

  it('records truncated false and no row cap or units when the producer gives none', async () => {
    const ctx = session();
    const dataset = await bridge.stage(ctx, stageOptions());
    const [meta] = await bridge.describe(ctx, dataset?.name);
    expect(meta?.truncated).toBe(false);
    expect(meta).not.toHaveProperty('maxRows');
    expect(meta).not.toHaveProperty('columnUnits');
  });

  it("reuses the tenant's one canvas, so tables staged by separate calls join in one query", async () => {
    const first = await bridge.stage(session(), stageOptions());
    const canvasId = await queryCtx().state.get('canvas-id');
    const second = await bridge.stage(
      session(),
      stageOptions({
        sourceTool: 'fdic_get_deposits',
        rows: [
          { cert: 57701, deposits: 1_350_666 },
          { cert: 33990, deposits: 52_011 },
        ],
        schema: [
          { name: 'cert', type: 'INTEGER' },
          { name: 'deposits', type: 'DOUBLE' },
        ],
      }),
    );
    expect(second?.name).not.toBe(first?.name);
    expect(await queryCtx().state.get('canvas-id')).toBe(canvasId);

    const { result } = await bridge.query(
      queryCtx(),
      `SELECT p.cert, d.deposits FROM ${first?.name} p JOIN ${second?.name} d ON p.cert = d.cert ORDER BY p.cert`,
      { rowLimit: 10 },
    );
    expect(result.rows).toEqual([
      { cert: 33990, deposits: 52_011 },
      { cert: 57701, deposits: 1_350_666 },
    ]);
  });

  it('keeps the inline answer on a staging failure: warns, returns undefined, records nothing', async () => {
    const ctx = session();
    const dataset = await bridge.stage(
      ctx,
      stageOptions({ rows: [{ cert: 1, name: 'X', report_date: 'not-a-date', roa: 1 }] }),
    );
    expect(dataset).toBeUndefined();
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({ sourceTool: 'fdic_query_financials' }),
      }),
    );
    expect(await bridge.describe(ctx)).toEqual([]);
  });

  it('rethrows a failure on a cancelled call, so cancellation is not reported as success', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = session({ signal: controller.signal });
    await expect(bridge.stage(ctx, stageOptions())).rejects.toMatchObject({ name: 'AbortError' });
    expect(await bridge.describe(session())).toEqual([]);
  });
});

describe('describe', () => {
  it('lists live dataframes newest first, one by name, and none for a name never staged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const older = await bridge.stage(session(), stageOptions());
    vi.setSystemTime(T0.getTime() + 60_000);
    const newer = await bridge.stage(session(), stageOptions({ sourceTool: 'fdic_get_deposits' }));

    const all = await bridge.describe(session());
    expect(all.map((m) => m.tableName)).toEqual([newer?.name, older?.name]);
    expect((await bridge.describe(session(), older?.name)).map((m) => m.sourceTool)).toEqual([
      'fdic_query_financials',
    ]);
    expect(await bridge.describe(session(), 'df_NEVER_STAGE')).toEqual([]);
  });

  it('pages through more than one page of provenance, and sweeps every page once expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const names: string[] = [];
    for (let i = 0; i < 105; i++) {
      vi.setSystemTime(T0.getTime() + i * 1000);
      const dataset = await bridge.stage(
        session(),
        stageOptions({
          rows: [{ cert: i + 1, name: `BANK ${i}`, report_date: '2026-06-30', roa: i }],
        }),
      );
      if (!dataset) throw new Error(`staging ${i} failed`);
      names.push(dataset.name);
    }

    const listed = await bridge.describe(session());
    expect(listed).toHaveLength(105);
    expect(listed.map((m) => m.tableName)).toEqual([...names].reverse());

    vi.setSystemTime(T0.getTime() + 104_000 + DAY_MS);
    expect(await bridge.describe(session())).toEqual([]);
    expect(await canvasTables()).toEqual([]);
  });
});

describe('lazy TTL sweep', () => {
  it('drops an expired table and its provenance on the next operation, keeping younger ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const expiring = await bridge.stage(session(), stageOptions());
    vi.setSystemTime(T0.getTime() + DAY_MS / 2);
    const living = await bridge.stage(session(), stageOptions());

    vi.setSystemTime(T0.getTime() + DAY_MS);
    expect((await bridge.describe(session())).map((m) => m.tableName)).toEqual([living?.name]);
    expect(await canvasTables()).toEqual([living?.name]);

    const error = await rejection(
      bridge.query(queryCtx(), `SELECT * FROM ${expiring?.name}`, { rowLimit: 10 }),
    );
    expect(error.data).toMatchObject({ reason: 'missing_table', tableName: expiring?.name });
  });
});

describe('canvas expiry', () => {
  beforeEach(async () => {
    await canvas.shutdown(createMockContext());
    useCanvas({ canvasTtlMs: 3_600_000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  it('forgets the dataframes of an expired canvas and stages on a fresh canvas', async () => {
    const lost = await bridge.stage(session(), stageOptions());
    const firstCanvas = await queryCtx().state.get('canvas-id');

    vi.setSystemTime(T0.getTime() + 2 * 3_600_000);
    const fresh = await bridge.stage(session(), stageOptions());
    expect(fresh?.name).toMatch(TABLE_NAME);
    expect(await queryCtx().state.get('canvas-id')).not.toBe(firstCanvas);
    expect((await bridge.describe(session())).map((m) => m.tableName)).toEqual([fresh?.name]);
    expect(lost?.name).not.toBe(fresh?.name);
  });

  it('answers a query on a dataframe of an expired canvas as missing_table with the contract recovery', async () => {
    const lost = await bridge.stage(session(), stageOptions());
    vi.setSystemTime(T0.getTime() + 2 * 3_600_000);

    const error = await rejection(
      bridge.query(queryCtx(), `SELECT * FROM ${lost?.name}`, { rowLimit: 10 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'missing_table',
      recovery: { hint: contractRecovery(dataframeQueryTool, 'missing_table') },
    });
    expect(await bridge.describe(session())).toEqual([]);
  });

  it('does not list dataframes whose canvas has expired, by name or in the full listing', async () => {
    const lost = await bridge.stage(session(), stageOptions());
    vi.setSystemTime(T0.getTime() + 2 * 3_600_000);
    expect(await bridge.describe(session(), lost?.name)).toEqual([]);
    expect(await bridge.describe(session())).toEqual([]);
    expect(await session().state.get(`df-meta/${lost?.name}`)).toBeNull();
    expect(await session().state.get('canvas-id')).toBeNull();
  });
});

describe('canvas creation', () => {
  it('mints no canvas for a describe or a drop on a tenant that never staged anything', async () => {
    expect(await bridge.describe(session())).toEqual([]);
    expect(await bridge.drop(session(), 'df_NEVER_STAGE')).toBe(false);
    expect(await session().state.get('canvas-id')).toBeNull();
  });
});

describe('query', () => {
  it('runs one SELECT with rowLimit and preview passed through, returning no provenance', async () => {
    const dataset = await bridge.stage(session(), stageOptions());
    const out = await bridge.query(queryCtx(), `SELECT cert FROM ${dataset?.name} ORDER BY cert`, {
      rowLimit: 2,
      preview: 1,
    });
    expect(out).toEqual({
      result: { columns: ['cert'], rowCount: 2, rows: [{ cert: 24900 }], truncated: true },
    });
  });

  it('materializes register_as with provenance read back from the canvas and no column units', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const source = await bridge.stage(session(), stageOptions());
    vi.setSystemTime(T0.getTime() + 5_000);
    const sql = `SELECT cert, roa * 2 AS roa_doubled, name\nFROM ${source?.name}`;

    const { result, meta } = await bridge.query(queryCtx(), sql, {
      rowLimit: 1,
      preview: 1,
      registerAs: 'df_DERIV_00001',
    });
    expect(result).toMatchObject({ tableName: 'df_DERIV_00001', rowCount: 3 });
    expect(result.rows).toHaveLength(1);
    expect(meta).toEqual({
      tableName: 'df_DERIV_00001',
      sourceTool: 'fdic_dataframe_query',
      queryParams: { sql },
      createdAt: new Date(T0.getTime() + 5_000).toISOString(),
      expiresAt: new Date(T0.getTime() + 5_000 + DAY_MS).toISOString(),
      rowCount: 3,
      truncated: false,
      columnSchema: [
        { name: 'cert', type: 'INTEGER', nullable: true },
        { name: 'roa_doubled', type: 'DOUBLE', nullable: true },
        { name: 'name', type: 'VARCHAR', nullable: true },
      ],
    });

    expect((await bridge.describe(session())).map((m) => m.tableName)).toEqual([
      'df_DERIV_00001',
      source?.name,
    ]);
    const again = await bridge.query(
      queryCtx(),
      'SELECT SUM(roa_doubled) AS total FROM df_DERIV_00001',
      { rowLimit: 10 },
    );
    expect(again.result.rows).toEqual([{ total: 2.32 }]);
  });

  it('refuses register_as naming a staged dataframe as register_as_clash with the contract recovery', async () => {
    const name = (await bridge.stage(session(), stageOptions()))?.name ?? '';
    const error = await rejection(
      bridge.query(queryCtx(), 'SELECT 1 AS x', { rowLimit: 10, registerAs: name }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({
      reason: 'register_as_clash',
      tableName: name,
      recovery: { hint: contractRecovery(dataframeQueryTool, 'register_as_clash') },
    });
  });

  it('fails a referenced df_ name that is not staged as missing_table, ignoring names in string literals', async () => {
    const dataset = await bridge.stage(session(), stageOptions());
    const error = await rejection(
      bridge.query(queryCtx(), 'SELECT * FROM df_ZZZZZ_ZZZZZ', { rowLimit: 10 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toEqual({
      reason: 'missing_table',
      tableName: 'df_ZZZZZ_ZZZZZ',
      recovery: { hint: contractRecovery(dataframeQueryTool, 'missing_table') },
    });

    const { result } = await bridge.query(
      queryCtx(),
      `SELECT 'df_ZZZZZ_ZZZZZ' AS label, COUNT(*) AS n FROM ${dataset?.name}`,
      { rowLimit: 10 },
    );
    expect(result.rows).toEqual([{ label: 'df_ZZZZZ_ZZZZZ', n: '3' }]);
  });

  it.each<[string, string, number]>([
    ['invalid_sql', 'SELECT nope FROM (VALUES (1)) t(x)', JsonRpcErrorCode.ValidationError],
    ['sql_execution_error', "SELECT CAST('abc' AS INTEGER) AS v", JsonRpcErrorCode.ValidationError],
    ['non_select_statement', 'DELETE FROM staging_scratch', JsonRpcErrorCode.ValidationError],
    ['multi_statement', 'SELECT 1; SELECT 2', JsonRpcErrorCode.ValidationError],
    ['denied_function', "SELECT * FROM read_csv('/etc/passwd')", JsonRpcErrorCode.ValidationError],
    ['plan_operator_not_allowed', 'SELECT * FROM range(5)', JsonRpcErrorCode.ValidationError],
    [
      'system_catalog_access',
      'SELECT table_name FROM information_schema.tables',
      JsonRpcErrorCode.ValidationError,
    ],
    ['missing_table', 'SELECT * FROM staging_scratch', JsonRpcErrorCode.NotFound],
  ])(
    'rethrows the framework %s with the contract recovery, keeping its code and cause',
    async (reason, sql, code) => {
      const error = await rejection(bridge.query(queryCtx(), sql, { rowLimit: 10 }));
      const hint = contractRecovery(dataframeQueryTool, reason);
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ reason, recovery: { hint } });
      expect(error.cause).toBeInstanceOf(McpError);
      const cause = error.cause as McpError;
      expect(cause.data).toMatchObject({ reason });
      expect((cause.data as { recovery?: { hint?: string } }).recovery?.hint).not.toBe(hint);
    },
  );

  it('folds the framework denied_function_in_plan into denied_function, keeping its detail', async () => {
    const planError = validationError(
      'Canvas query references disallowed table function in plan: read_json.',
      {
        reason: 'denied_function_in_plan',
        functions: ['read_json'],
        recovery: { hint: 'framework hint' },
      },
    );
    const double = {
      acquire: async () => ({
        canvasId: 'CanvasDbl01',
        query: async () => {
          throw planError;
        },
      }),
    } as unknown as DataCanvas;
    const error = await rejection(
      new CanvasBridge(double).query(queryCtx(), 'SELECT 1', { rowLimit: 10 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({
      reason: 'denied_function',
      functions: ['read_json'],
      recovery: { hint: contractRecovery(dataframeQueryTool, 'denied_function') },
    });
    expect(error.cause).toBe(planError);
  });

  it('passes a rejection the contract does not declare through with the framework hint', async () => {
    const error = await rejection(
      bridge.query(queryCtx(), 'SELECT * FROM (VALUES (1), (2), (3)) t(x)', {
        rowLimit: 2,
        preview: 3,
      }),
    );
    expect(error.data?.reason).toBe('invalid_query_bounds');
    const declared = (dataframeQueryTool.errors ?? []).map((e) => e.recovery);
    expect(declared).not.toContain(
      (error.data as { recovery?: { hint?: string } } | undefined)?.recovery?.hint,
    );
  });

  it('passes a non-McpError failure through unchanged', async () => {
    const boom = new Error('engine crashed');
    const double = {
      acquire: async () => ({
        canvasId: 'CanvasDbl01',
        query: async () => {
          throw boom;
        },
      }),
    } as unknown as DataCanvas;
    await expect(
      new CanvasBridge(double).query(queryCtx(), 'SELECT 1', { rowLimit: 10 }),
    ).rejects.toBe(boom);
  });
});

describe('drop', () => {
  it('drops a staged dataframe and its provenance; again, or for a name never staged, reports false', async () => {
    const dataset = await bridge.stage(session(), stageOptions());
    const kept = await bridge.stage(session(), stageOptions());
    const name = dataset?.name ?? '';

    expect(await bridge.drop(session(), name)).toBe(true);
    expect((await bridge.describe(session())).map((m) => m.tableName)).toEqual([kept?.name]);
    expect(await canvasTables()).toEqual([kept?.name]);
    await expect(
      bridge.query(queryCtx(), `SELECT * FROM ${name}`, { rowLimit: 10 }),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });

    expect(await bridge.drop(session(), name)).toBe(false);
    expect(await bridge.drop(session(), 'df_NEVER_STAGE')).toBe(false);
  });
});

describe('tenants', () => {
  it("keeps each tenant's dataframes on its own canvas and provenance", async () => {
    const alpha = tenantSession('alpha');
    const beta = tenantSession('beta');
    const dataset = await bridge.stage(alpha(), stageOptions());

    expect(await bridge.describe(beta())).toEqual([]);
    const error = await rejection(
      bridge.query(beta({ errors: dataframeQueryTool.errors }), `SELECT * FROM ${dataset?.name}`, {
        rowLimit: 10,
      }),
    );
    expect(error.data?.reason).toBe('missing_table');
    expect(await bridge.drop(beta(), dataset?.name ?? '')).toBe(false);
    expect((await bridge.describe(alpha())).map((m) => m.tableName)).toEqual([dataset?.name]);
  });
});

describe('initCanvasBridge', () => {
  afterEach(() => {
    initCanvasBridge(undefined);
  });

  it('installs a bridge over a configured canvas and none when the canvas is off', () => {
    initCanvasBridge(canvas);
    expect(getCanvasBridge()).toBeInstanceOf(CanvasBridge);
    initCanvasBridge(undefined);
    expect(getCanvasBridge()).toBeUndefined();
  });
});
