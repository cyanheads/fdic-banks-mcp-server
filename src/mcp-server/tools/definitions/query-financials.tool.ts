/**
 * @fileoverview fdic_query_financials — a multi-institution, multi-quarter Call
 * Report panel filtered by CERTs, state, asset range, and metric thresholds. An
 * aggregation preflight sizes the panel, quarters are fetched newest first up to
 * the panel row cap, and a panel larger than the inline preview is staged as a
 * dataframe for SQL.
 * @module mcp-server/tools/definitions/query-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  type ColumnUnit,
  getCanvasBridge,
  stagedNotice,
} from '@/services/canvas-bridge/canvas-bridge.js';
import {
  callBudget,
  getFdicService,
  PANEL_BUDGET_MS,
  planPanelQuarters,
} from '@/services/fdic/fdic-service.js';
import {
  METRIC_BASES,
  METRIC_CATALOG,
  METRIC_UNITS,
  type MetricName,
  metricDefinitions,
  resolveMetrics,
} from '@/services/fdic/metric-catalog.js';
import { reportDateToIso } from '@/services/fdic/query-builder.js';
import type { MetricFilter, PanelFilters, PanelRow } from '@/services/fdic/types.js';
import { normalizeState } from '@/services/fdic/us-states.js';
import { blankAsUnset, metricEnum, reportDateInput, stateInput } from '../input-schemas.js';
import { cell, inline, metricValue, num } from '../markdown.js';

const MetricDefinitionSchema = z
  .object({
    metric: z.string().describe("Catalog metric name, the key it has in each row's values."),
    field: z.string().describe('FDIC Call Report field code the metric maps to, e.g. ROAQ.'),
    unit: z.enum(METRIC_UNITS).describe('usd_thousands, percent (1.71 = 1.71%), or count.'),
    basis: z
      .enum(METRIC_BASES)
      .describe(
        'point_in_time = balance at quarter end; quarter = that quarter alone; quarter_annualized = ratio from the quarter, annualized; year_to_date = accumulated since January 1; ytd_annualized = ratio from the year-to-date flow, annualized.',
      ),
    note: z.string().optional().describe('Caveat, such as zero meaning not reported.'),
  })
  .describe('Definition of one metric in the rows.');

/** Order: the sort metric (nulls last), then newest quarter, then lowest CERT. */
function comparePanelRows(sortBy: MetricName | undefined, order: 'asc' | 'desc') {
  return (a: PanelRow, b: PanelRow): number => {
    if (sortBy) {
      const av = a.values[sortBy] ?? null;
      const bv = b.values[sortBy] ?? null;
      if (av !== bv) {
        if (av === null) return 1;
        if (bv === null) return -1;
        return order === 'asc' ? av - bv : bv - av;
      }
    }
    if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1;
    return a.cert - b.cert;
  };
}

export const queryFinancialsTool = tool('fdic_query_financials', {
  title: 'Query a multi-bank financial panel',
  description:
    'Pull a multi-institution, multi-quarter Call Report panel — one row per institution per quarter — filtered by CERTs, headquarters state, asset range, and thresholds on any catalog metric. Use it to screen (every bank in a state with a noncurrent-loan rate above 3%) or to build a trend panel for SQL. Returns an inline preview sorted as requested; when the panel exceeds the preview it is staged as a dataframe for fdic_dataframe_query. With no dates it covers the latest published quarter only.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    certs: z
      .array(z.number().int().min(1).describe('FDIC certificate number.'))
      .max(100)
      .optional()
      .describe('Up to 100 CERTs to include; omit to screen every filer.'),
    state: stateInput(
      'Headquarters state: two-letter code in any case or full name. Branch locations are in fdic_get_deposits.',
    ),
    min_assets: blankAsUnset(z.number().min(0).optional()).describe(
      "Minimum total assets in that quarter, thousands of US dollars (1000000 = $1 billion); applied to each quarter's report.",
    ),
    max_assets: blankAsUnset(z.number().min(0).optional()).describe(
      "Maximum total assets in that quarter, thousands of US dollars; applied to each quarter's report.",
    ),
    metric_filters: z
      .array(
        z
          .object({
            metric: metricEnum,
            min: blankAsUnset(z.number().optional()).describe(
              "Inclusive lower bound in the metric's unit: percent for ratios (3 = 3%), thousands of dollars for amounts.",
            ),
            max: blankAsUnset(z.number().optional()).describe(
              "Inclusive upper bound in the metric's unit.",
            ),
          })
          .describe('One threshold: a metric with min, max, or both.'),
      )
      .max(5)
      .optional()
      .describe(
        'Up to 5 metric thresholds, all of which a row must meet. A threshold on a capital ratio or insured_deposit_share skips filers that did not report it. Each filtered metric is added to metrics.',
      ),
    metrics: z
      .array(metricEnum)
      .max(30)
      .optional()
      .describe(
        'Up to 30 metric names (fdic_list_reference topic metrics) to return. Omit for the default health set.',
      ),
    from_date: reportDateInput(
      'Earliest quarter: a quarter-end date (2024-03-31), the same without dashes, or a quarter label (2024Q1). Omit for to_date alone.',
    ),
    to_date: reportDateInput(
      'Latest quarter, in the same forms as from_date. Omit for the latest published quarter; beside from_date, a later quarter is cut back to it.',
    ),
    sort_by: blankAsUnset(metricEnum.optional()).describe(
      'Metric to order the preview (and the staged table) by; added to metrics when absent. Omit to order by newest quarter, then CERT.',
    ),
    sort_order: blankAsUnset(z.enum(['asc', 'desc']).default('desc')).describe(
      'desc (default, largest first) or asc; applies to sort_by. Rows without a value sort last.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(500).default(50)).describe(
      'Rows returned inline (1–500). A panel with more rows is also staged whole as a dataframe when this deployment stages dataframes.',
    ),
  }),

  output: z.object({
    report_dates: z
      .object({
        from: z.string().describe('Earliest quarter-end covered (YYYY-MM-DD).'),
        to: z
          .string()
          .describe(
            'Latest quarter-end covered (YYYY-MM-DD), never past the latest published quarter.',
          ),
      })
      .describe('Quarter range as applied.'),
    report_dates_defaulted: z
      .boolean()
      .describe(
        'True when neither from_date nor to_date was given, so only the latest published quarter was covered.',
      ),
    total_matching: z
      .number()
      .int()
      .describe('Institution-quarter rows at FDIC matching the filters.'),
    rows_fetched: z.number().int().describe('Rows fetched into the panel.'),
    panel_row_cap: z.number().int().describe("This server's row cap for one panel."),
    panel_truncated: z
      .boolean()
      .describe(
        'True when total_matching exceeded the panel row cap. Whole quarters are kept newest first, so a truncated panel is missing its oldest quarters — or, when the newest quarter alone exceeds the cap, the higher-numbered CERTs of that quarter.',
      ),
    rows: z
      .array(
        z
          .object({
            cert: z.number().int().describe('FDIC certificate number.'),
            name: z.string().describe('Name as filed on the Call Report for the quarter.'),
            state: z.string().describe('Headquarters state postal code.'),
            report_date: z.string().describe('Quarter-end report date (YYYY-MM-DD).'),
            values: z
              .record(z.string(), z.number().nullable())
              .describe(
                "Metric name → value in that metric's unit (see metric_definitions); null when not reported.",
              ),
          })
          .describe('One institution-quarter.'),
      )
      .describe('Inline preview of the panel, sorted as requested.'),
    metric_definitions: z
      .array(MetricDefinitionSchema)
      .describe('Field, unit, and basis of each metric in rows.'),
    dataset: z
      .object({
        name: z.string().describe('Dataframe name for fdic_dataframe_query.'),
        row_count: z.number().int().describe('Rows staged: the whole fetched panel.'),
        expires_at: z.string().describe('When the dataframe is dropped (ISO 8601).'),
      })
      .optional()
      .describe(
        'The staged full panel; present only when the panel exceeded the preview and this deployment staged it as a dataframe.',
      ),
    data_as_of: z.string().describe('When FDIC last rebuilt the financials index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance for zero matches, a capped panel, or where the full panel is staged.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the preview holds fewer rows than were fetched.'),
    shown: z.number().optional().describe('Rows in the preview.'),
    cap: z.number().optional().describe('The limit applied to the preview.'),
  },

  errors: [
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'state is not a US state, DC, or territory code or name',
      recovery: 'Pass a two-letter postal code such as WA or a full state name such as Washington.',
      severity: 'notice',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'from_date is after to_date, or the requested quarters (from_date, or to_date alone) start after the latest published quarter',
      recovery: 'Set from_date on or before to_date, or omit one of them.',
      severity: 'notice',
    },
    {
      reason: 'invalid_metric_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A metric_filters entry has neither min nor max, or min exceeds max',
      recovery:
        'Give each metric_filters entry a min, a max, or both, with min at or below max, in the unit fdic_list_reference topic metrics gives.',
      severity: 'notice',
    },
    {
      reason: 'invalid_asset_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'min_assets exceeds max_assets',
      recovery: 'Set min_assets at or below max_assets, both in thousands of dollars.',
      severity: 'notice',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's shared FDIC request queue is saturated and the call would wait past its budget",
      recovery:
        'The shared FDIC request budget is busy; wait retryAfter seconds and call again, or narrow the request to fewer quarters or institutions.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'FDIC answered 429 and retries were exhausted',
      recovery:
        'FDIC is throttling requests; wait retryAfter seconds before calling again, and send fewer, narrower calls.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const state = input.state === undefined ? undefined : normalizeState(input.state);
    if (input.state !== undefined && state === undefined) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a US state, DC, or territory.`, {
        ...ctx.recoveryFor('invalid_state'),
      });
    }
    if (
      input.min_assets !== undefined &&
      input.max_assets !== undefined &&
      input.min_assets > input.max_assets
    ) {
      throw ctx.fail(
        'invalid_asset_range',
        `min_assets (${input.min_assets}) exceeds max_assets (${input.max_assets}).`,
        { ...ctx.recoveryFor('invalid_asset_range') },
      );
    }
    const metricFilters: MetricFilter[] = [];
    for (const [index, f] of (input.metric_filters ?? []).entries()) {
      if (f.min === undefined && f.max === undefined) {
        throw ctx.fail(
          'invalid_metric_filter',
          `metric_filters[${index}] (${f.metric}) has neither min nor max.`,
          { ...ctx.recoveryFor('invalid_metric_filter') },
        );
      }
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
        throw ctx.fail(
          'invalid_metric_filter',
          `metric_filters[${index}] (${f.metric}) has min ${f.min} above max ${f.max}.`,
          { ...ctx.recoveryFor('invalid_metric_filter') },
        );
      }
      metricFilters.push({
        metric: f.metric,
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
      });
    }
    const fromInput = input.from_date === undefined ? undefined : reportDateToIso(input.from_date);
    const toInput = input.to_date === undefined ? undefined : reportDateToIso(input.to_date);
    if (fromInput && toInput && fromInput > toInput) {
      throw ctx.fail('invalid_date_range', `from_date ${fromInput} is after to_date ${toInput}.`, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }

    const metrics = [
      ...new Set<MetricName>([
        ...resolveMetrics(input.metrics),
        ...metricFilters.map((f) => f.metric),
        ...(input.sort_by ? [input.sort_by] : []),
      ]),
    ];
    const certs = input.certs?.length ? [...new Set(input.certs)] : undefined;
    // A minimum of 0 bounds nothing; a form client sends it for an untouched field.
    const minAssets = input.min_assets || undefined;
    const filters: PanelFilters = {
      ...(certs ? { certs } : {}),
      ...(state ? { state } : {}),
      ...(minAssets !== undefined ? { minAssets } : {}),
      ...(input.max_assets !== undefined ? { maxAssets: input.max_assets } : {}),
      ...(metricFilters.length ? { metricFilters } : {}),
    };

    const service = getFdicService();
    const budget = callBudget(PANEL_BUDGET_MS);
    const defaulted = fromInput === undefined && toInput === undefined;
    const latest = (await service.latestReportDate(ctx, budget)).reportDate;
    // to_date alone is a one-quarter panel, so it opens the window when from_date is omitted.
    const start = fromInput ?? toInput ?? latest;
    if (start > latest) {
      const field = fromInput === undefined ? 'to_date' : 'from_date';
      // Omitting from_date alone would leave a to_date alone that fails the same way.
      const omit = fromInput !== undefined && toInput !== undefined ? 'omit both dates' : 'omit it';
      throw ctx.fail(
        'invalid_date_range',
        `${field} ${start} is after ${latest}, the latest published quarter.`,
        {
          recovery: {
            hint: `Set ${field} on or before ${latest} (the latest published quarter), or ${omit}.`,
          },
        },
      );
    }
    const clamped = toInput !== undefined && toInput > latest;
    const to = clamped || toInput === undefined ? latest : toInput;
    const from = fromInput ?? to;
    const clampNote = clamped
      ? `to_date ${toInput} is after the latest published quarter, so the panel ends at ${latest}.`
      : undefined;

    const panelMaxRows = getServerConfig().panelMaxRows;
    const preflight = await service.panelQuarterCounts(filters, from, to, ctx, budget);
    const plan = planPanelQuarters(preflight.quarters, panelMaxRows);
    const plannedRows = plan.reduce((sum, q) => sum + q.rows, 0);
    const panel = plan.length
      ? await service.getPanelRows(filters, plan, metrics, ctx, budget)
      : [];
    panel.sort(comparePanelRows(input.sort_by, input.sort_order));
    const panelTruncated = plannedRows < preflight.total;
    const preview = panel.slice(0, input.limit);

    const bridge = getCanvasBridge();
    const dataset =
      bridge && panel.length > input.limit
        ? await bridge.stage(ctx, {
            sourceTool: 'fdic_query_financials',
            queryParams: { ...input },
            rows: panel.map((row) => ({
              cert: row.cert,
              name: row.name,
              state: row.state,
              report_date: row.report_date,
              ...Object.fromEntries(metrics.map((metric) => [metric, row.values[metric] ?? null])),
            })),
            schema: [
              { name: 'cert', type: 'INTEGER' },
              { name: 'name', type: 'VARCHAR' },
              { name: 'state', type: 'VARCHAR' },
              { name: 'report_date', type: 'DATE' },
              ...metrics.map((metric): ColumnSchema => ({ name: metric, type: 'DOUBLE' })),
            ],
            columnUnits: Object.fromEntries(
              metrics.map((metric): [string, ColumnUnit] => {
                const { unit, basis } = METRIC_CATALOG[metric];
                return [metric, { unit, basis }];
              }),
            ),
            truncated: panelTruncated,
            ...(panelTruncated ? { maxRows: panelMaxRows } : {}),
          })
        : undefined;

    if (preflight.total === 0) {
      const fragments: string[] = [];
      if (clampNote) fragments.push(clampNote);
      if (defaulted) {
        fragments.push(
          `Only the latest published quarter (${to}) was searched; set from_date to cover earlier quarters.`,
        );
      }
      if (metricFilters.length) {
        fragments.push(
          "Metric thresholds are in each metric's unit — percentages for ratios (3 = 3%), thousands of dollars for amounts; fdic_list_reference with topic metrics lists each unit. Capital ratios are null for filers that do not report them.",
        );
      }
      const assetBounded = minAssets !== undefined || input.max_assets !== undefined;
      if (assetBounded) {
        fragments.push('Asset bounds are in thousands of dollars (1000000 = $1 billion).');
      }
      if (state) {
        fragments.push(
          'state is the headquarters state; branch locations are in fdic_get_deposits.',
        );
      }
      if (certs) {
        const narrowedBeyondCerts = state !== undefined || assetBounded || metricFilters.length > 0;
        fragments.push(
          narrowedBeyondCerts
            ? 'These CERTs may also have filed for none of the requested quarters; check them with fdic_search_institutions.'
            : 'None of these CERTs filed for the requested quarters; check them with fdic_search_institutions.',
        );
      }
      ctx.enrich.notice(
        fragments.length ? fragments.join(' ') : 'No Call Report rows matched these filters.',
      );
    } else {
      const notes: string[] = clampNote ? [clampNote] : [];
      if (panel.length > preview.length) {
        notes.push(`Showing ${preview.length} of ${panel.length} fetched rows.`);
      }
      if (panelTruncated) {
        const partial = plan.length === 1 && plannedRows < (preflight.quarters[0]?.rows ?? 0);
        notes.push(
          partial
            ? `The newest quarter alone exceeds this server's panel row cap (${panelMaxRows}), so only its first ${plannedRows} institutions by CERT were fetched and the other ${preflight.total - plannedRows} matching rows were not; narrow the filters.`
            : `The panel matched ${preflight.total} rows, and only the newest ${plan.length} quarters (${plannedRows} rows) fit this server's panel row cap (${panelMaxRows}); the older quarters are missing — narrow the filters or the date range to cover them.`,
        );
      }
      if (dataset) notes.push(stagedNotice(dataset));
      else if (panel.length > preview.length) {
        notes.push('Raise limit (max 500) or narrow the filters to see the rest inline.');
      }
      if (panel.length > preview.length) {
        ctx.enrich.truncated({
          shown: preview.length,
          cap: input.limit,
          guidance: notes.join(' '),
        });
      } else if (notes.length) {
        ctx.enrich.notice(notes.join(' '));
      }
    }

    ctx.log.info('Financial panel', {
      from,
      to,
      totalMatching: preflight.total,
      fetched: panel.length,
      staged: dataset?.name,
    });

    return {
      report_dates: { from, to },
      report_dates_defaulted: defaulted,
      total_matching: preflight.total,
      rows_fetched: panel.length,
      panel_row_cap: panelMaxRows,
      panel_truncated: panelTruncated,
      rows: preview,
      metric_definitions: metricDefinitions(metrics),
      ...(dataset ? { dataset } : {}),
      data_as_of: preflight.dataAsOf,
    };
  },

  format: (result) => {
    const lines = [
      `## Call Report panel — ${result.report_dates.from} to ${result.report_dates.to}`,
      `Report dates ${result.report_dates_defaulted ? 'defaulted to the latest published quarter' : 'as requested'}. Data as of ${result.data_as_of}. Dollar amounts are thousands of US dollars.`,
      `${num(result.total_matching)} matching institution-quarters · ${num(result.rows_fetched)} fetched (panel row cap ${num(result.panel_row_cap)}${result.panel_truncated ? '; panel truncated at the row cap — matching rows past it were not fetched' : '; panel complete'}) · ${result.rows.length} shown.`,
    ];
    if (result.dataset) {
      lines.push(
        `**Staged:** ${result.dataset.name} — ${num(result.dataset.row_count)} rows, expires ${result.dataset.expires_at}. Query it with fdic_dataframe_query.`,
      );
    }

    const columns: string[] = [];
    for (const row of result.rows) {
      for (const key of Object.keys(row.values)) if (!columns.includes(key)) columns.push(key);
    }
    const units = new Map(result.metric_definitions.map((def) => [def.metric, def.unit]));
    if (result.rows.length) {
      lines.push(
        '',
        `| CERT | Name | State | Report date | ${columns.map(cell).join(' | ')} |`,
        `|--:|:--|:--|:--|${columns.map(() => '--:').join('|')}|`,
      );
      for (const row of result.rows) {
        const values = columns.map((metric) => metricValue(row.values[metric], units.get(metric)));
        lines.push(
          `| ${row.cert} | ${cell(row.name)} | ${cell(row.state)} | ${row.report_date} | ${values.join(' | ')} |`,
        );
      }
    }

    lines.push(
      '',
      '**Metrics** (usd_thousands values are thousands of US dollars; — means not reported):',
    );
    for (const def of result.metric_definitions) {
      const note = def.note ? ` — ${inline(def.note)}` : '';
      lines.push(
        `- ${def.metric}: field ${def.field} · unit ${def.unit} · basis ${def.basis}${note}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
