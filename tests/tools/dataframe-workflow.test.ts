/**
 * @fileoverview End-to-end dataframe workflow for one tenant over the faked FDIC
 * transport and a real in-memory DuckDB canvas: fdic_query_financials and
 * fdic_get_deposits stage oversized results, fdic_dataframe_describe lists them
 * and describes one by name with provenance and column units,
 * fdic_dataframe_query joins them and materializes the join
 * with register_as, and fdic_dataframe_drop removes a source while the
 * materialized join lives on.
 * @module tests/tools/dataframe-workflow.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getDepositsTool } from '@/mcp-server/tools/definitions/get-deposits.tool.js';
import { queryFinancialsTool } from '@/mcp-server/tools/definitions/query-financials.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeFdicService } from '@/services/fdic/fdic-service.js';
import {
  BOSTON_BRANCH,
  MAIN_OFFICE_BRANCH,
  panelRow,
  RURAL_BRANCH,
  sodBranch,
} from '../fixtures/fdic-records.js';
import { createDuckdbCanvas, tenantSession } from '../helpers/canvas.js';
import {
  aggEnvelope,
  envelope,
  FakeFdic,
  installFakeService,
  requestedQuarters,
} from '../helpers/fake-fdic.js';

const T0 = new Date('2026-09-26T12:00:00.000Z');
const HARBOR = { NAME: 'EVERGREEN HARBOR BK', STALP: 'WA' };
const CEDAR = { NAME: 'CEDAR FLATS CMNTY BK', STALP: 'WA' };

const PANEL: Record<string, Record<string, unknown>[]> = {
  '20260630': [panelRow(33990, '20260630', CEDAR), panelRow(57701, '20260630', HARBOR)],
  '20260331': [panelRow(33990, '20260331', CEDAR), panelRow(57701, '20260331', HARBOR)],
};

const BRANCHES = [
  MAIN_OFFICE_BRANCH,
  BOSTON_BRANCH,
  RURAL_BRANCH,
  ...Array.from({ length: 27 }, (_, i) => sodBranch(20 + i)),
];

let fake: FakeFdic;
let duck: DataCanvas;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  fake = new FakeFdic()
    .on(
      'financials',
      (p) => p.fields === 'REPDTE',
      envelope('financials', [{ REPDTE: '20260630', ID: '57701_20260630' }]),
    )
    .on(
      'financials',
      (p) => p.agg_by === 'REPDTE',
      aggEnvelope('financials', 'REPDTE', [
        { key: '20260331', count: 2 },
        { key: '20260630', count: 2 },
      ]),
    )
    .on(
      'financials',
      (p) => p.sort_by === 'CERT',
      (request) =>
        envelope(
          'financials',
          requestedQuarters(request.params.filters, Object.keys(PANEL)).flatMap(
            (repdte) => PANEL[repdte] ?? [],
          ),
        ),
    )
    .on('sod', (p) => p.fields === 'YEAR', envelope('sod', [{ YEAR: 2026, ID: '2026_1_1' }]))
    .on('sod', (p) => p.sort_by === 'BRNUM', envelope('sod', BRANCHES))
    .on('sod', (p) => p.agg_by === 'STALPBR', aggEnvelope('sod', 'STALPBR', []));
  installFakeService(fake);
  duck = createDuckdbCanvas();
  initCanvasBridge(duck);
});

afterEach(async () => {
  vi.useRealTimers();
  disposeFdicService();
  initCanvasBridge(undefined);
  await duck.shutdown(createMockContext());
});

describe('dataframe workflow', () => {
  it('stages two producers, joins them with SQL, materializes the join, and drops a source', async () => {
    const session = tenantSession();

    const panel = await queryFinancialsTool.handler(
      queryFinancialsTool.input.parse({
        certs: [57701, 33990],
        metrics: ['total_deposits', 'roa'],
        from_date: '2026Q1',
        to_date: '2026Q2',
        limit: 1,
      }),
      session({ errors: queryFinancialsTool.errors }),
    );
    vi.setSystemTime(T0.getTime() + 1000);
    const deposits = await getDepositsTool.handler(
      getDepositsTool.input.parse({ cert: 57701, limit: 2 }),
      session({ errors: getDepositsTool.errors }),
    );
    const panelName = panel.dataset?.name ?? '';
    const branchName = deposits.dataset?.name ?? '';
    expect(panel.dataset?.row_count).toBe(4);
    expect(deposits.dataset?.row_count).toBe(30);

    const describe = (input: { name?: string }) =>
      dataframeDescribeTool.handler(
        dataframeDescribeTool.input.parse(input),
        session({ errors: dataframeDescribeTool.errors }),
      );
    expect(await describe({})).toEqual({
      dataframes: [
        {
          name: branchName,
          source_tool: 'fdic_get_deposits',
          row_count: 30,
          expires_at: expect.any(String),
        },
        {
          name: panelName,
          source_tool: 'fdic_query_financials',
          row_count: 4,
          expires_at: expect.any(String),
        },
      ],
      total: 2,
    });
    const [panelMeta] = (await describe({ name: panelName })).dataframes;
    expect(panelMeta?.column_units).toEqual({
      total_deposits: { unit: 'usd_thousands', basis: 'point_in_time' },
      roa: { unit: 'percent', basis: 'quarter_annualized' },
    });

    vi.setSystemTime(T0.getTime() + 2000);
    const sql = `SELECT p.cert, p.report_date, p.total_deposits, b.branches, b.sod_deposits
FROM ${panelName} p
JOIN (SELECT cert, CAST(COUNT(*) AS INTEGER) AS branches, SUM(deposits) AS sod_deposits FROM ${branchName} GROUP BY cert) b ON p.cert = b.cert
ORDER BY p.report_date DESC`;
    const joined = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql, register_as: 'df_JOIN0_00001' }),
      session({ errors: dataframeQueryTool.errors }),
    );
    expect(joined).toMatchObject({
      columns: ['cert', 'report_date', 'total_deposits', 'branches', 'sod_deposits'],
      row_count: 2,
      row_count_capped: false,
      registered_as: 'df_JOIN0_00001',
      rows: [
        {
          cert: 57701,
          report_date: '2026-06-30',
          total_deposits: 2_101_456,
          branches: 30,
          sod_deposits: 1_628_557,
        },
        {
          cert: 57701,
          report_date: '2026-03-31',
          total_deposits: 2_101_456,
          branches: 30,
          sod_deposits: 1_628_557,
        },
      ],
    });

    const [derived] = (await describe({ name: 'df_JOIN0_00001' })).dataframes;
    expect(derived).toMatchObject({
      source_tool: 'fdic_dataframe_query',
      query_params: { sql },
      row_count: 2,
      truncated: false,
    });
    expect(derived).not.toHaveProperty('column_units');

    const dropped = await dataframeDropTool.handler(
      dataframeDropTool.input.parse({ name: panelName }),
      session({ errors: dataframeDropTool.errors }),
    );
    expect(dropped).toEqual({ name: panelName, dropped: true });
    await expect(
      dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: `SELECT * FROM ${panelName}` }),
        session({ errors: dataframeQueryTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table', tableName: panelName },
    });

    const survivors = await dataframeQueryTool.handler(
      dataframeQueryTool.input.parse({ sql: 'SELECT COUNT(*) AS n FROM df_JOIN0_00001' }),
      session({ errors: dataframeQueryTool.errors }),
    );
    expect(survivors.rows).toEqual([{ n: '2' }]);
    const after = await describe({});
    expect(after.dataframes.map((d) => d.name)).toEqual(['df_JOIN0_00001', branchName]);
  });
});
