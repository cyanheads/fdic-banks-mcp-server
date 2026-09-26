/**
 * @fileoverview fdic_dataframe_describe — list the staged df_<id> dataframes with
 * their source tool, parameters, row count, expiry, column schema, and column units.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { blankAsUnset } from '../input-schemas.js';
import { inline } from '../markdown.js';

export const dataframeDescribeTool = tool('fdic_dataframe_describe', {
  title: 'Describe staged dataframes',
  description:
    'List the df_<id> dataframes that fdic_query_financials and fdic_get_deposits staged when a result exceeded its inline preview, plus any that fdic_dataframe_query saved with register_as: source tool, the parameters it was called with, row count, creation and expiry time, column schema, and the unit and basis of each amount, ratio, or count column (thousands of dollars, percent, or count). Read the columns here before writing SQL for fdic_dataframe_query. Pass name for one dataframe; omit it to list every live one, newest first.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: blankAsUnset(
      z
        .string()
        .regex(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/, 'Expected a dataframe name such as df_AB12C_3DE45')
        .optional(),
    ).describe(
      'A dataframe name (df_XXXXX_XXXXX, from a dataset field) to describe one; omit to list all.',
    ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Dataframe name to use in SQL.'),
            source_tool: z.string().describe('Tool that staged it.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe('Input of the call that staged it (for fdic_dataframe_query, the SQL).'),
            created_at: z.string().describe('When it was staged (ISO 8601).'),
            expires_at: z.string().describe('When it is dropped (ISO 8601).'),
            row_count: z.number().int().describe('Rows staged.'),
            truncated: z
              .boolean()
              .describe('True when the source result held more rows than were staged.'),
            max_rows: z
              .number()
              .int()
              .optional()
              .describe('The row cap that bound the source result, when one did.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('Column type: INTEGER, DOUBLE, VARCHAR, DATE, …'),
                    nullable: z.boolean().describe('Whether the column may hold NULL.'),
                  })
                  .describe('One column.'),
              )
              .describe('Columns in table order.'),
            column_units: z
              .record(
                z.string(),
                z
                  .object({
                    unit: z
                      .string()
                      .describe(
                        'usd_thousands (thousands of US dollars), percent (1.71 = 1.71%), or count.',
                      ),
                    basis: z
                      .string()
                      .optional()
                      .describe(
                        'point_in_time, quarter, quarter_annualized, year_to_date, or ytd_annualized.',
                      ),
                  })
                  .describe('Unit and basis of one column.'),
              )
              .optional()
              .describe(
                'Column → unit and basis, for the amount, ratio, and count columns the producing tool labeled; absent for register_as dataframes, whose derived columns carry no unit.',
              ),
          })
          .describe('One staged dataframe.'),
      )
      .describe('Live dataframes, newest first; empty when nothing is staged.'),
  }),

  enrichment: {
    notice: z.string().optional().describe('Guidance when no dataframe matched.'),
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured in this deployment',
      recovery:
        'Dataframes are off in this deployment; use the inline rows the fdic_ tools return, or ask the operator to set CANVAS_PROVIDER_TYPE=duckdb.',
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }
    const entries = await bridge.describe(ctx, input.name);
    if (entries.length === 0) {
      ctx.enrich.notice(
        input.name
          ? `${input.name} is not staged — it expired or was never created. Omit name to list the live dataframes, or re-run the tool that produced it.`
          : 'Nothing is staged. fdic_query_financials and fdic_get_deposits stage a dataframe when a result exceeds their inline preview.',
      );
    }
    return {
      dataframes: entries.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        truncated: meta.truncated,
        ...(meta.maxRows !== undefined ? { max_rows: meta.maxRows } : {}),
        column_schema: meta.columnSchema.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
        })),
        ...(meta.columnUnits ? { column_units: meta.columnUnits } : {}),
      })),
    };
  },

  format: (result) => {
    const lines = [`## ${result.dataframes.length} staged dataframe(s)`];
    for (const df of result.dataframes) {
      lines.push('', `### ${df.name}`);
      lines.push(`- Source: ${df.source_tool}`);
      const cap = df.max_rows !== undefined ? ` (row cap ${df.max_rows})` : '';
      lines.push(
        `- Rows: ${df.row_count} · truncated: ${df.truncated ? 'yes — the source held more' : 'no'}${cap}`,
      );
      lines.push(`- Created ${df.created_at} · expires ${df.expires_at}`);
      lines.push('- Parameters of the staging call (query_params):');
      for (const [key, value] of Object.entries(df.query_params)) {
        if (key === 'sql' && typeof value === 'string') {
          lines.push('  - sql:', '', ...value.split(/\r\n|\r|\n/).map((line) => `> ${line}`), '');
        } else {
          lines.push(`  - ${inline(key)}: ${inline(JSON.stringify(value) ?? 'null')}`);
        }
      }
      lines.push('- Columns:');
      for (const column of df.column_schema) {
        lines.push(
          `  - ${inline(column.name)} ${column.type}${column.nullable ? ' (nullable)' : ''}`,
        );
      }
      if (df.column_units) {
        lines.push('- Column units:');
        for (const [column, unit] of Object.entries(df.column_units)) {
          lines.push(`  - ${inline(column)}: ${unit.unit}${unit.basis ? `, ${unit.basis}` : ''}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
