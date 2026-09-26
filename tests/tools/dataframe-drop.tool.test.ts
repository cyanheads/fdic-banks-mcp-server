/**
 * @fileoverview Tests for fdic_dataframe_drop over a real in-memory DuckDB
 * canvas: canvas_unavailable, dropping a name that is not staged through the
 * production contract, dropping a staged dataframe on one tenant's state (and
 * again, idempotently), and malformed names.
 * @module tests/tools/dataframe-drop.tool.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { createDuckdbCanvas, tenantSession } from '../helpers/canvas.js';
import { contractRecovery, structured, textOf, toolError } from '../helpers/tool-results.js';

const tool = dataframeDropTool;

let duck: DataCanvas;

beforeEach(() => {
  duck = createDuckdbCanvas();
  initCanvasBridge(duck);
});

afterEach(async () => {
  initCanvasBridge(undefined);
  await duck.shutdown(createMockContext());
});

describe('fdic_dataframe_drop', () => {
  it('fails canvas_unavailable with its contract recovery when the canvas is off', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(tool, { name: 'df_AB12C_3DE45' });
    expect(toolError(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_unavailable',
        recovery: { hint: contractRecovery(tool, 'canvas_unavailable') },
      },
    });
  });

  it('reports a name that is not staged as dropped false, on both surfaces', async () => {
    const result = await runToolContract(tool, { name: 'df_AB12C_3DE45' });
    expect(structured(result)).toEqual({ name: 'df_AB12C_3DE45', dropped: false });
    expect(textOf(result)).toBe('df_AB12C_3DE45 was not staged; nothing dropped (dropped: false).');
  });

  it('drops a staged dataframe and its provenance, and reports a second drop as false', async () => {
    const session = tenantSession();
    const bridge = getCanvasBridge();
    const staged = await bridge?.stage(session(), {
      sourceTool: 'fdic_get_deposits',
      queryParams: { cert: 57701 },
      rows: [{ cert: 57701, deposits: 1 }],
      schema: [
        { name: 'cert', type: 'INTEGER' },
        { name: 'deposits', type: 'DOUBLE' },
      ],
    });
    const name = staged?.name ?? '';

    const first = await tool.handler(tool.input.parse({ name }), session({ errors: tool.errors }));
    expect(first).toEqual({ name, dropped: true });
    expect(tool.format?.(first)).toEqual([
      { type: 'text', text: `Dropped ${name} (dropped: true).` },
    ]);
    expect(await bridge?.describe(session())).toEqual([]);

    const again = await tool.handler(tool.input.parse({ name }), session({ errors: tool.errors }));
    expect(again).toEqual({ name, dropped: false });
  });

  it.each(['', 'df_ab12c_3de45', 'orders', 'df_AB12C_3DE45; DROP TABLE x'])(
    'rejects the malformed name %j at the schema',
    async (name) => {
      const result = await runToolContract(tool, { name });
      expect(toolError(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
    },
  );
});
