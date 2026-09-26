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
import { cell } from '../markdown.js';

/** A result value in one table cell. */
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
    preview: blankAsUnset(z.number().int().min(0).max(10_000).optional()).describe(
      'Rows to return inline (0–10,000); defaults to row_limit, and a value above row_limit is treated as row_limit. Set it low when register_as keeps the full result.',
    ),
    row_limit: blankAsUnset(z.number().int().min(1).max(10_000).default(1000)).describe(
      'Hard cap on rows materialized (1–10,000). A query matching more stops here and row_count_capped comes back true; use register_as to keep the whole result.',
    ),
  }),

  output: z.object({
    columns: z.array(z.string().describe('Column name.')).describe('Columns in projection order.'),
    row_count: z
      .number()
      .int()
      .describe(
        'Rows the query produced, up to row_limit; with register_as, the exact count of the new dataframe.',
      ),
    row_count_capped: z
      .boolean()
      .describe('True when the query matched more rows than row_limit, so row_count is that cap.'),
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
        'Dataframes are off in this deployment; use the inline rows the fdic_ tools return, or ask the operator to set CANVAS_PROVIDER_TYPE=duckdb.',
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
      when: 'The SQL calls a file-reading or external-data table function such as read_csv or read_parquet',
      recovery:
        'Remove the file-reading function and query only df_ tables named in a dataset field or by fdic_dataframe_describe.',
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
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }
    // preview above row_limit would be refused by the canvas; row_limit already bounds it.
    const preview =
      input.preview === undefined ? undefined : Math.min(input.preview, input.row_limit);
    const { result, meta } = await bridge.query(ctx, input.sql, {
      rowLimit: input.row_limit,
      ...(preview !== undefined ? { preview } : {}),
      ...(input.register_as ? { registerAs: input.register_as } : {}),
    });

    const previewBinds = preview !== undefined && preview < input.row_limit;
    const cap = previewBinds ? preview : input.row_limit;
    const lever = previewBinds ? 'raise preview' : 'raise row_limit (max 10,000)';
    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'The query returned no rows. Check the WHERE conditions and the dataframe names with fdic_dataframe_describe.',
      );
    } else if (result.truncated === true) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: `Showing ${result.rows.length} rows. The query matched more than row_limit (${input.row_limit}), so row_count is that cap, not the full size. Use register_as to materialize the whole result with an exact row_count, or ${lever}.`,
      });
    } else if (result.rowCount > result.rows.length) {
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap,
        guidance: `Showing ${result.rows.length} of ${result.rowCount} rows; ${lever}${meta ? `, or query ${meta.tableName}` : ', or use register_as to keep the full result'}.`,
      });
    }

    ctx.log.info('Dataframe query', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    return {
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
    if (result.rows.length === 0) {
      lines.push('', `Columns: ${result.columns.map(cell).join(', ') || 'none'}`);
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
