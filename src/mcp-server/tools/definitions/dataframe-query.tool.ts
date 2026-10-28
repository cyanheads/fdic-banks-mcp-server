/**
 * @fileoverview fdic_dataframe_query — one read-only SELECT across the staged
 * df_<id> dataframes, optionally materialized as a new dataframe. The framework
 * gate enforces read-only SQL with system catalogs denied; its rejections carry
 * this tool's recovery text.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { blankAsUnset } from '../input-schemas.js';
import { cell, inline } from '../markdown.js';

/** A result value in one table cell: SQL NULL leaves it empty, and `cell()` renders `''` as `""`. */
function valueCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return cell(value);
  if (typeof value === 'object') return cell(JSON.stringify(value));
  return String(value);
}

export const dataframeQueryTool = tool('fdic_dataframe_query', {
  title: 'Query staged dataframes with SQL',
  description:
    'Run one read-only SELECT (DuckDB SQL) across the df_<id> dataframes that fdic_query_financials and fdic_get_deposits staged or an earlier register_as saved; joins, aggregates, window functions, and CTEs work. Before writing SQL, pass each table name to fdic_dataframe_describe to read its columns. DOUBLE columns come back as JSON numbers and dollar columns are thousands of US dollars; BIGINT results such as COUNT(*) come back as strings, so CAST them to INTEGER or DOUBLE for arithmetic. Writes, DDL, file-reading functions, and system catalogs are rejected. register_as materializes the result as a new dataframe with a fresh TTL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    sql: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        'One SELECT against df_<id> tables named in a dataset field or by fdic_dataframe_describe, up to 20,000 characters.',
      ),
    register_as: blankAsUnset(
      z
        .string()
        .regex(
          /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/,
          'Expected df_ then two groups of five uppercase letters or digits, e.g. df_AB12C_3DE45',
        )
        .optional(),
    ).describe(
      'Materialize the full result as a new dataframe under this unused name (df_XXXXX_XXXXX: uppercase letters and digits). A name already staged fails as register_as_clash — including on a repeat of a call that already saved it. The live dataframes share a 1,000,000-row budget: the oldest are dropped to make room, and a result over the budget on its own fails as register_as_too_large. Omit to return rows only.',
    ),
    preview: blankAsUnset(z.number().int().min(0).optional()).describe(
      'Rows to return inline; defaults to the effective row_limit and is clamped to it. Set it low when register_as keeps the full result.',
    ),
    row_limit: blankAsUnset(z.number().int().min(1).max(1_000_000).default(1000)).describe(
      'Requested materialization cap (default 1,000; hard input ceiling 1,000,000), clamped to the execution cap of 10,000. Without register_as, row_count_capped reports more matches; continue with ordered LIMIT/OFFSET pages. register_as keeps the whole result within the staging budget.',
    ),
  }),

  output: z.object({
    requested_row_limit: z.number().int().describe('Requested row_limit before the execution cap.'),
    effective_row_limit: z.number().int().describe('Effective row_limit, at most 10,000.'),
    requested_preview: z
      .number()
      .int()
      .optional()
      .describe('Explicit preview before clamping; absent when omitted.'),
    effective_preview: z
      .number()
      .int()
      .describe('Inline row cap after clamping preview to the effective row_limit.'),
    columns: z.array(z.string().describe('Column name.')).describe('Columns in projection order.'),
    row_count: z
      .number()
      .int()
      .describe(
        'Rows the query produced, up to effective_row_limit; with register_as, the exact count of the new dataframe.',
      ),
    row_count_capped: z
      .boolean()
      .describe(
        'True when the query matched more rows than effective_row_limit, so row_count is that cap.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()).describe('One result row: column → value.'))
      .describe('Result rows, bounded by preview and row_limit.'),
    registered_as: z.string().optional().describe('Name of the dataframe register_as created.'),
    expires_at: z
      .string()
      .optional()
      .describe('When the register_as dataframe is dropped (ISO 8601).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the query returned no rows or a cap withheld some.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when rows were withheld by preview or row_limit.'),
    shown: z.number().optional().describe('Rows returned inline.'),
    cap: z.number().optional().describe('The cap that bound: preview when lower, else row_limit.'),
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured in this deployment',
      recovery:
        'Dataframes are off in this deployment; page fdic_query_financials and fdic_get_deposits with offset and next_offset instead. A self-hosted server turns them on with CANVAS_PROVIDER_TYPE=duckdb.',
      severity: 'notice',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'A table the SQL names is not staged — a df_ name that expired, was dropped to make room for newer dataframes, or is mistyped, or any other table name',
      recovery:
        'Re-run the tool that staged the dataframe to stage it again, or correct the name to one a dataset field returned.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A SELECT fails to parse or prepare (syntax error, unknown column or function, bad expression)',
      recovery:
        "Pass the table's name to fdic_dataframe_describe to check its column names and types, then fix the SQL.",
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SELECT prepared but failed on the data',
      recovery:
        'Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'non_select_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The statement is not a SELECT, or cannot be parsed as one',
      recovery:
        'Send one read-only SELECT against df_ tables named in a dataset field or by fdic_dataframe_describe.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'multi_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL holds more than one statement',
      recovery:
        'Send exactly one SELECT statement per call and split the rest into separate calls.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'denied_function',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL calls a file-reading, external-data, engine-setting, or dynamic SQL function the read-only gate refuses, or names current_schema unqualified, which DuckDB reads as the current_schema() function',
      recovery:
        'Remove the refused function, or qualify a column named current_schema with its table (t.current_schema); query only df_ tables named in a dataset field or by fdic_dataframe_describe.',
      // Reaching past the staged tables: a modeled rejection, but worth an operator's eye.
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'plan_operator_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query plan uses an operator outside the read-only allowlist (scans of staged tables, filters, joins, aggregates, set operations, sorts, window functions, CTEs, unnest)',
      recovery:
        'Rewrite with plain SELECT constructs — joins, aggregates, window functions, CTEs, and unnest are supported.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL references a system catalog: information_schema, pg_catalog, sqlite_master, or a duckdb_*() function',
      recovery: 'Query only df_ tables named in a dataset field or by fdic_dataframe_describe.',
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      when: 'register_as names a dataframe that is already staged',
      recovery: 'Choose an unused df_XXXXX_XXXXX name for register_as, or omit it.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'register_as_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The register_as result holds more rows than the staging budget (1,000,000 rows) allows on its own',
      recovery:
        'Aggregate or filter the SQL so the result is smaller, or omit register_as and read the rows inline.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }
    const rowLimit = Math.min(input.row_limit, 10_000);
    const preview = Math.min(input.preview ?? rowLimit, rowLimit);
    const adjusted =
      rowLimit !== input.row_limit || (input.preview !== undefined && preview !== input.preview);
    const boundsNotice = adjusted
      ? `Requested row_limit ${input.row_limit}${input.preview !== undefined ? ` and preview ${input.preview}` : ''}; effective row_limit ${rowLimit} and preview ${preview}. `
      : '';
    const { result, meta } = await bridge.query(ctx, input.sql, {
      rowLimit,
      preview,
      ...(input.register_as ? { registerAs: input.register_as } : {}),
    });

    const previewBinds = preview < rowLimit;
    const cap = preview;
    const lever = previewBinds
      ? `raise preview up to ${rowLimit}`
      : rowLimit < 10_000
        ? 'raise row_limit up to 10,000'
        : 'read ordered LIMIT/OFFSET pages';
    if (result.rowCount === 0) {
      ctx.enrich.notice(
        `${boundsNotice}The query returned no rows. Check the WHERE conditions and the dataframe names with fdic_dataframe_describe.`,
      );
    } else if (result.truncated === true) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: `${boundsNotice}Showing ${result.rows.length} rows. More rows matched than the effective row_limit (${rowLimit}), so row_count is that cap, not the full size. Continue with a stable ORDER BY and LIMIT/OFFSET pages, use register_as to keep the result within the staging budget, or ${lever}.`,
      });
    } else if (result.rowCount > result.rows.length) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: `${boundsNotice}Showing ${result.rows.length} of ${result.rowCount} rows; ${lever}${meta ? `, or query ${meta.tableName} with ordered LIMIT/OFFSET pages` : ', or use register_as to keep the full result within the staging budget'}.`,
      });
    } else if (adjusted) {
      ctx.enrich.notice(
        `${boundsNotice}Continue with a stable ORDER BY and LIMIT/OFFSET pages, or use register_as to keep the result within the staging budget.`,
      );
    }

    ctx.log.info('Dataframe query', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    return {
      requested_row_limit: input.row_limit,
      effective_row_limit: rowLimit,
      ...(input.preview !== undefined ? { requested_preview: input.preview } : {}),
      effective_preview: preview,
      columns: result.columns,
      row_count: result.rowCount,
      row_count_capped: result.truncated === true,
      rows: result.rows,
      ...(meta ? { registered_as: meta.tableName, expires_at: meta.expiresAt } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(`Registered as ${result.registered_as}, expires ${result.expires_at ?? ''}.`);
    }
    const capped = result.row_count_capped
      ? ' — capped at row_limit; more rows matched (row_count_capped: true)'
      : '';
    const shown =
      result.rows.length < result.row_count
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    lines.push(`**${result.row_count} row(s)**${capped}${shown}`);
    lines.push(
      `Requested row_limit ${result.requested_row_limit}; effective row_limit ${result.effective_row_limit}. Preview: requested ${result.requested_preview ?? 'default'}, effective ${result.effective_preview}.`,
    );
    if (result.rows.length === 0) {
      lines.push('', `Columns: ${result.columns.map(inline).join(', ') || 'none'}`);
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('', `| ${result.columns.map(cell).join(' | ')} |`);
    lines.push(`|${result.columns.map(() => ' --- ').join('|')}|`);
    for (const row of result.rows) {
      lines.push(`| ${result.columns.map((column) => valueCell(row[column])).join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
