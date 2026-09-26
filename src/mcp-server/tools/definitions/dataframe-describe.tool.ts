/**
 * @fileoverview fdic_dataframe_describe — list the staged df_<id> dataframes as
 * summary rows, 50 per page, or describe one by name: its source tool,
 * parameters, row count, expiry, column schema, and column units. The listing
 * is refused where every caller shares one canvas (HTTP without auth).
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { blankAsUnset } from '../input-schemas.js';
import { cell, inline, splitLines } from '../markdown.js';

/** Summary rows per page of the unnamed listing. */
const LISTING_PAGE = 50;

export const dataframeDescribeTool = tool('fdic_dataframe_describe', {
  title: 'Describe staged dataframes',
  description:
    "Describe the df_<id> dataframes that fdic_query_financials and fdic_get_deposits staged when a result exceeded its inline preview, plus any that fdic_dataframe_query saved with register_as. Pass name (from a dataset field) for one dataframe in full: source tool, the parameters it was called with, row count, creation and expiry time, column schema, and the unit and basis of each amount, ratio, or count column (thousands of dollars, percent, or count). Read a table's columns this way before writing SQL for fdic_dataframe_query. Omit name to list the live dataframes, newest first, 50 per page, as name, source tool, row count, and expiry only. A deployment that serves HTTP without authentication, where every caller shares one canvas, does not list; there, pass the name a dataset field returned.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: blankAsUnset(
      z
        .string()
        .regex(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/, 'Expected a dataframe name such as df_AB12C_3DE45')
        .optional(),
    ).describe(
      'A dataframe name (df_XXXXX_XXXXX, from a dataset field) for its provenance, columns, and units; omit to list the live dataframes where this deployment allows it.',
    ),
    offset: blankAsUnset(z.number().int().min(0).default(0)).describe(
      'Listed dataframes to skip; pass next_offset from the previous page. Ignored when name is set.',
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
              .optional()
              .describe(
                'Input of the call that staged it (for fdic_dataframe_query, the SQL); present with name.',
              ),
            created_at: z
              .string()
              .optional()
              .describe('When it was staged (ISO 8601); present with name.'),
            expires_at: z.string().describe('When it is dropped (ISO 8601).'),
            row_count: z.number().int().describe('Rows staged.'),
            truncated: z
              .boolean()
              .optional()
              .describe(
                'True when the source result held more rows than were staged; present with name.',
              ),
            max_rows: z
              .number()
              .int()
              .optional()
              .describe('The row cap that bound the source result, when one did; with name only.'),
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
              .optional()
              .describe('Columns in table order; present with name.'),
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
                'Column → unit and basis, for the amount, ratio, and count columns the producing tool labeled; with name only, and absent for register_as dataframes, whose derived columns carry no unit.',
              ),
          })
          .describe('One staged dataframe.'),
      )
      .describe(
        'The named dataframe in full, or one page of the live dataframes as summary rows, newest first; empty when none matched.',
      ),
    total: z
      .number()
      .int()
      .describe('Live dataframes across all pages of the listing; with name, 1 or 0.'),
    next_offset: z
      .number()
      .int()
      .optional()
      .describe('Offset of the next page of the listing; present when more dataframes remain.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, the page is past the end, the page starts past the first dataframe, or more pages remain.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more dataframes remain beyond this page.'),
    shown: z.number().optional().describe('Dataframes listed on this page.'),
    cap: z.number().optional().describe('Dataframes per page of the listing.'),
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
    {
      reason: 'listing_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'name is omitted on a deployment that serves HTTP without authentication, where every caller shares one canvas',
      recovery:
        'Pass name set to a dataframe name you hold: the dataset.name of the call that staged it, or the register_as name you chose.',
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
    if (!input.name && !bridge.listing) {
      throw ctx.fail(
        'listing_unavailable',
        'Listing dataframes is off on this deployment: every caller shares one canvas, so a dataframe is reached only by its name.',
        { ...ctx.recoveryFor('listing_unavailable') },
      );
    }
    const entries = await bridge.describe(ctx, input.name);
    const total = entries.length;

    if (input.name) {
      if (total === 0) {
        const next = bridge.listing
          ? 'Omit name to list the live dataframes, or re-run the tool that produced it.'
          : 'Re-run the tool that produced it.';
        ctx.enrich.notice(
          `${input.name} is not staged — it expired, was dropped to make room for newer dataframes, or was never created. ${next}`,
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
        total,
      };
    }

    const page = entries.slice(input.offset, input.offset + LISTING_PAGE);
    const end = input.offset + page.length;
    const hasMore = end < total;
    if (total === 0) {
      ctx.enrich.notice(
        'Nothing is staged. fdic_query_financials and fdic_get_deposits stage a dataframe when a result exceeds their inline preview.',
      );
    } else if (page.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the last of ${total} dataframes; lower offset or omit it.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: page.length,
        cap: LISTING_PAGE,
        guidance: `Showing dataframes ${input.offset + 1}–${end} of ${total}, newest first; pass offset ${end} for the next page, or name for one dataframe's columns.`,
      });
    } else if (input.offset > 0) {
      ctx.enrich.notice(
        `Showing dataframes ${input.offset + 1}–${end} of ${total}, newest first; omit offset to list from the first, or pass name for one dataframe's columns.`,
      );
    }
    return {
      dataframes: page.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        row_count: meta.rowCount,
        expires_at: meta.expiresAt,
      })),
      total,
      ...(hasMore ? { next_offset: end } : {}),
    };
  },

  format: (result) => {
    const lines = [`## ${result.total} staged dataframe(s)`];
    if (result.next_offset !== undefined) lines.push(`Next page: offset ${result.next_offset}.`);

    const summaries = result.dataframes.filter((df) => df.column_schema === undefined);
    if (summaries.length) {
      lines.push(
        '',
        "Pass name for one dataframe's parameters, columns, and units.",
        '',
        '| Name | Source tool | Rows | Expires |',
        '|:--|:--|--:|:--|',
        ...summaries.map(
          (df) =>
            `| ${cell(df.name)} | ${cell(df.source_tool)} | ${df.row_count} | ${cell(df.expires_at)} |`,
        ),
      );
    }

    for (const df of result.dataframes) {
      if (df.column_schema === undefined) continue;
      lines.push('', `### ${df.name}`);
      lines.push(`- Source: ${df.source_tool}`);
      const truncation =
        df.truncated === undefined
          ? ''
          : ` · truncated: ${df.truncated ? 'yes — the source held more' : 'no'}`;
      const cap = df.max_rows !== undefined ? ` (row cap ${df.max_rows})` : '';
      lines.push(`- Rows: ${df.row_count}${truncation}${cap}`);
      lines.push(
        df.created_at !== undefined
          ? `- Created ${df.created_at} · expires ${df.expires_at}`
          : `- Expires ${df.expires_at}`,
      );
      if (df.query_params) {
        lines.push('- Parameters of the staging call (query_params):');
        for (const [key, value] of Object.entries(df.query_params)) {
          if (key === 'sql' && typeof value === 'string') {
            lines.push('  - sql:', '', ...splitLines(value).map((line) => `> ${line}`), '');
          } else {
            lines.push(`  - ${inline(key)}: ${inline(JSON.stringify(value) ?? 'null')}`);
          }
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
