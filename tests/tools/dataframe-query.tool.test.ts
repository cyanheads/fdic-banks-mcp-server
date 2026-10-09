/**
 * @fileoverview Tests for fdic_dataframe_query over a real in-memory DuckDB
 * canvas: canvas_unavailable, the zero-row page, preview- and row_limit-bound
 * pages, preview clamped to row_limit, register_as with an exact count, every
 * SQL rejection rethrown under this tool's reason with its contract recovery,
 * register_as_clash on one tenant's state and its contract recovery,
 * register_as_too_large past the
 * staging budget, blank and malformed inputs, and result values in both
 * structuredContent and the rendered table.
 * @module tests/tools/dataframe-query.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import {
  type CanvasBridge,
  getCanvasBridge,
  initCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas, tenantSession } from '../helpers/canvas.js';
import { contractRecovery, structured, textOf, toolError } from '../helpers/tool-results.js';

type Output = z.infer<typeof dataframeQueryTool.output> & {
  cap?: number;
  notice?: string;
  shown?: number;
  truncated?: boolean;
};
type Input = z.input<typeof dataframeQueryTool.input>;

const tool = dataframeQueryTool;
const FIVE_ROWS = 'SELECT * FROM (VALUES (1), (2), (3), (4), (5)) t(x)';

let duck: DataCanvas;

beforeEach(() => {
  duck = createDuckdbCanvas();
  initCanvasBridge(duck);
});

afterEach(async () => {
  vi.restoreAllMocks();
  initCanvasBridge(undefined);
  await duck.shutdown(createMockContext());
});

async function run(input: Input) {
  const result = await runToolContract(tool, input);
  return { result, text: textOf(result) };
}

describe('pages through the production contract', () => {
  it('fails canvas_unavailable with its contract recovery when the canvas is off', async () => {
    initCanvasBridge(undefined);
    const { result } = await run({ sql: 'SELECT 1' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        recovery: { hint: contractRecovery(tool, 'canvas_unavailable') },
      },
    });
  });

  it('validates the zero-row page with its notice on both surfaces', async () => {
    const { result, text } = await run({ sql: 'SELECT 1 AS x WHERE false' });
    const output = structured<Output>(result);
    expect(output).toMatchObject({
      columns: ['x'],
      row_count: 0,
      row_count_capped: false,
      rows: [],
    });
    expect(output.notice).toEqual(expect.stringContaining('fdic_dataframe_describe'));
    expect(output).not.toHaveProperty('truncated');
    expect(text).toContain('**0 row(s)**');
    expect(text).toContain('Columns: x');
    expect(text).toMatch(/^> .*fdic_dataframe_describe/m);
  });

  it('validates an under-cap page bound by preview on both surfaces', async () => {
    const { result, text } = await run({ sql: FIVE_ROWS, preview: 2 });
    expect(structured<Output>(result)).toMatchObject({
      row_count: 5,
      row_count_capped: false,
      rows: [{ x: 1 }, { x: 2 }],
      truncated: true,
      shown: 2,
      cap: 2,
    });
    expect(text).toContain('**5 row(s)** (showing 2 of 5)');
    expect(text).toContain('| x |\n| --- |\n| 1 |\n| 2 |');
  });

  it('reports a result capped by row_limit as row_count_capped, on both surfaces', async () => {
    const { result, text } = await run({ sql: FIVE_ROWS, row_limit: 3 });
    expect(structured<Output>(result)).toMatchObject({
      row_count: 3,
      row_count_capped: true,
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
      truncated: true,
      shown: 3,
      cap: 3,
    });
    expect(text).toContain(
      '**3 row(s)** — capped at row_limit; more rows matched (row_count_capped: true)',
    );
  });

  it('clamps a preview above row_limit to row_limit rather than letting the canvas refuse it', async () => {
    const { result } = await run({ sql: FIVE_ROWS, preview: 5000, row_limit: 3 });
    expect(structured<Output>(result)).toMatchObject({
      row_count: 3,
      row_count_capped: true,
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
      cap: 3,
    });
  });

  it('returns no rows inline for preview 0 while reporting the full count', async () => {
    const { result, text } = await run({ sql: FIVE_ROWS, preview: 0 });
    expect(structured<Output>(result)).toMatchObject({
      row_count: 5,
      rows: [],
      truncated: true,
      shown: 0,
      cap: 0,
    });
    expect(text).toContain('**5 row(s)** (showing 0 of 5)');
  });

  it('materializes register_as with an exact count past row_limit and names it on both surfaces', async () => {
    const { result, text } = await run({
      sql: FIVE_ROWS,
      register_as: 'df_AB12C_3DE45',
      row_limit: 2,
    });
    const output = structured<Output>(result);
    expect(output).toMatchObject({
      registered_as: 'df_AB12C_3DE45',
      row_count: 5,
      row_count_capped: false,
      rows: [{ x: 1 }, { x: 2 }],
      truncated: true,
      shown: 2,
    });
    expect(Date.parse(output.expires_at ?? '')).toBeGreaterThan(Date.now());
    expect(output.notice).toContain('df_AB12C_3DE45');
    expect(text).toContain(`Registered as df_AB12C_3DE45, expires ${output.expires_at}.`);
  });

  it('reads blank register_as and preview as unset', async () => {
    const { result } = await run({
      sql: FIVE_ROWS,
      register_as: ' ',
      preview: '',
    } as unknown as Input);
    const output = structured<Output>(result);
    expect(output).not.toHaveProperty('registered_as');
    expect(output.rows).toHaveLength(5);
    expect(output).not.toHaveProperty('truncated');
  });

  it('returns typed values in structuredContent and renders them as table cells', async () => {
    const { result, text } = await run({
      sql: "SELECT 1.5::DOUBLE AS d, COUNT(*) AS n, DATE '2026-06-30' AS day, [1, 2] AS list, NULL AS nothing, 'a|b' AS piped, 'line1' || chr(10) || '# SYSTEM' AS multi",
    });
    expect(structured<Output>(result).rows).toEqual([
      {
        d: 1.5,
        n: '1',
        day: '2026-06-30',
        list: [1, 2],
        nothing: null,
        piped: 'a|b',
        multi: 'line1\n# SYSTEM',
      },
    ]);
    expect(text).toContain('| d | n | day | list | nothing | piped | multi |');
    expect(text).toContain('| 1.5 | 1 | 2026-06-30 | [1,2] |  | a\\|b | line1 # SYSTEM |');
    expect(text).not.toContain('\n# SYSTEM');
  });
});

describe('SQL rejections', () => {
  it.each<[string, string, number]>([
    ['missing_table', 'SELECT * FROM df_AB12C_3DE45', JsonRpcErrorCode.NotFound],
    ['missing_table', 'SELECT * FROM staging_scratch', JsonRpcErrorCode.NotFound],
    ['invalid_sql', 'SELECT nope FROM (VALUES (1)) t(x)', JsonRpcErrorCode.ValidationError],
    ['sql_execution_error', "SELECT CAST('abc' AS INTEGER) AS v", JsonRpcErrorCode.ValidationError],
    ['non_select_statement', 'DELETE FROM staging_scratch', JsonRpcErrorCode.ValidationError],
    ['multi_statement', 'SELECT 1; SELECT 2', JsonRpcErrorCode.ValidationError],
    ['denied_function', "SELECT * FROM read_csv('/etc/passwd')", JsonRpcErrorCode.ValidationError],
    ['plan_operator_not_allowed', 'SELECT * FROM range(5)', JsonRpcErrorCode.ValidationError],
    [
      'system_catalog_access',
      'SELECT * FROM information_schema.tables',
      JsonRpcErrorCode.ValidationError,
    ],
  ])('rejects %s with this tool contract recovery: %s', async (reason, sql, code) => {
    const { result, text } = await run({ sql });
    expect(toolError(result)).toMatchObject({
      code,
      data: { reason, recovery: { hint: contractRecovery(tool, reason) } },
    });
    expect(text).toContain(`reason ${reason}`);
    expect(text).toContain(contractRecovery(tool, reason));
  });

  it('says a missing df_ table may have been dropped to make room, on both surfaces', async () => {
    const { result, text } = await run({ sql: 'SELECT * FROM df_AB12C_3DE45' });
    const error = toolError(result);
    expect(error.data?.reason).toBe('missing_table');
    expect(error.message).toContain('dropped to make room for newer dataframes');
    expect(text).toContain('dropped to make room for newer dataframes');
  });

  it('refuses a register_as result larger than the staging budget as register_as_too_large, on both surfaces', async () => {
    initCanvasBridge(duck, { maxStagedRows: 4 });
    const { result, text } = await run({ sql: FIVE_ROWS, register_as: 'df_AB12C_3DE45' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('5 rows'),
      data: {
        reason: 'register_as_too_large',
        rowCount: 5,
        maxStagedRows: 4,
        recovery: { hint: contractRecovery(tool, 'register_as_too_large') },
      },
    });
    expect(text).toContain('reason register_as_too_large');
    expect(text).toContain('5 rows');
    expect(text).toContain(contractRecovery(tool, 'register_as_too_large'));
  });

  it('refuses register_as naming a staged dataframe as register_as_clash', async () => {
    const session = tenantSession();
    const staged = await getCanvasBridge()?.stage(session(), {
      sourceTool: 'fdic_query_financials',
      queryParams: {},
      rows: [{ cert: 1 }],
      schema: [{ name: 'cert', type: 'INTEGER' }],
    });
    const name = staged?.name ?? '';
    await expect(
      tool.handler(
        tool.input.parse({ sql: `SELECT * FROM ${name}`, register_as: name }),
        session({ errors: tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'register_as_clash', tableName: name },
    });
  });

  it('carries the register_as_clash recovery the bridge leaves to the contract, on both surfaces', async () => {
    vi.spyOn(getCanvasBridge() as CanvasBridge, 'query').mockRejectedValueOnce(
      validationError('A dataframe named df_AB12C_3DE45 already exists.', {
        reason: 'register_as_clash',
        tableName: 'df_AB12C_3DE45',
      }),
    );
    const { result, text } = await run({ sql: 'SELECT 1', register_as: 'df_AB12C_3DE45' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'register_as_clash',
        recovery: { hint: contractRecovery(tool, 'register_as_clash') },
      },
    });
    expect(text).toContain(contractRecovery(tool, 'register_as_clash'));
  });

  it.each<[string, Record<string, unknown>]>([
    ['an empty statement', { sql: '' }],
    ['sql over 20,000 characters', { sql: `SELECT 1 AS n -- ${'x'.repeat(20_000)}` }],
    ['a lowercase register_as', { sql: 'SELECT 1', register_as: 'df_ab12c_3de45' }],
    ['an uppercase DF_ prefix', { sql: 'SELECT 1', register_as: 'DF_AB12C_3DE45' }],
    ['a short register_as', { sql: 'SELECT 1', register_as: 'df_AB12C' }],
    ['row_limit 0', { sql: 'SELECT 1', row_limit: 0 }],
    ['row_limit over 10,000', { sql: 'SELECT 1', row_limit: 10_001 }],
    ['a negative preview', { sql: 'SELECT 1', preview: -1 }],
    ['a fractional preview', { sql: 'SELECT 1', preview: 1.5 }],
  ])('rejects %s at the schema', async (_label, input) => {
    const { result } = await run(input as Input);
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
  });

  it('runs sql of exactly 20,000 characters and names the cap on one more, on both surfaces', async () => {
    const sqlOf = (length: number) => `SELECT 1 AS n -- ${'x'.repeat(length - 17)}`;
    expect(sqlOf(20_000)).toHaveLength(20_000);
    expect(structured<Output>((await run({ sql: sqlOf(20_000) })).result).rows).toEqual([{ n: 1 }]);

    const { result, text } = await run({ sql: sqlOf(20_001) });
    expect(toolError(result).message).toMatch(/20000/);
    expect(text).toMatch(/20000/);
  });
});
