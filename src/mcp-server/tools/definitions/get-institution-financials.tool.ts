/**
 * @fileoverview fdic_get_institution_financials — one institution's quarterly Call
 * Report history, most recent first, with its profile.
 * @module mcp-server/tools/definitions/get-institution-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { callBudget, getFdicService } from '@/services/fdic/fdic-service.js';
import {
  METRIC_BASES,
  METRIC_UNITS,
  metricDefinitions,
  resolveMetrics,
} from '@/services/fdic/metric-catalog.js';
import { reportDateToIso } from '@/services/fdic/query-builder.js';
import { blankAsUnset, metricEnum, reportDateInput } from '../input-schemas.js';
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

export const getInstitutionFinancialsTool = tool('fdic_get_institution_financials', {
  title: 'Get institution quarterly financials',
  description:
    "Get one institution's quarterly Call Report financials by CERT — balance sheet, income, returns, credit quality, and capital ratios — most recent quarter first, with its name, status, and holding company. Unsuffixed income and return metrics are single-quarter figures; _ytd metrics accumulate from January 1. Dollar amounts are in thousands. Quarterly data lands about seven weeks after quarter end; history reaches back to 1984.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    cert: z
      .number()
      .int()
      .min(1)
      .describe('FDIC certificate number, from fdic_search_institutions.'),
    metrics: z
      .array(metricEnum)
      .max(25)
      .optional()
      .describe(
        'Up to 25 metric names (fdic_list_reference topic metrics). Omit for the default health set: assets, deposits, uninsured deposits, equity, net income, ROA, ROE, net interest margin, efficiency, noncurrent-loan and charge-off rates, loans to deposits, and capital ratios.',
      ),
    quarters: blankAsUnset(z.number().int().min(1).max(200).default(8)).describe(
      'Most recent quarters to return (1–200; 200 covers the whole history back to 1984). Within from_date/to_date it caps the count.',
    ),
    from_date: reportDateInput(
      'Earliest quarter to include: a quarter-end date (2025-03-31), the same without dashes (20250331), or a quarter label (2025Q1).',
    ),
    to_date: reportDateInput(
      'Latest quarter to include, in the same forms as from_date. Omit for the latest published quarter.',
    ),
  }),

  output: z.object({
    institution: z
      .object({
        cert: z.number().int().describe('FDIC certificate number.'),
        name: z.string().describe('Current legal name, or the name at closing.'),
        active: z.boolean().describe('True while the charter is open and insured.'),
        city: z.string().describe('Headquarters city.'),
        state: z.string().describe('Headquarters state postal code.'),
        holding_company: z
          .object({
            name: z.string().describe('Top-tier holding company name.'),
            rssd: z
              .number()
              .int()
              .optional()
              .describe('Federal Reserve RSSD ID of the holding company.'),
          })
          .optional()
          .describe('Top-tier holding company; absent when none is on record.'),
        last_report_date: z
          .string()
          .optional()
          .describe('Quarter-end date of the latest Call Report on file (YYYY-MM-DD).'),
        ended_on: z
          .string()
          .optional()
          .describe('Date the charter ended (YYYY-MM-DD); inactive institutions only.'),
        successor_cert: z
          .number()
          .int()
          .optional()
          .describe('CERT of the institution that continued the franchise.'),
      })
      .describe(
        'Institution identity, status, holding company, and succession; fdic_search_institutions with certs returns the full record (charter class, regulator, county, dates, latest assets).',
      ),
    metric_definitions: z
      .array(MetricDefinitionSchema)
      .describe('Field, unit, and basis of each metric in rows.'),
    rows: z
      .array(
        z
          .object({
            report_date: z.string().describe('Quarter-end report date (YYYY-MM-DD).'),
            values: z
              .record(z.string(), z.number().nullable())
              .describe(
                "Metric name → value in that metric's unit (see metric_definitions); null when not reported.",
              ),
          })
          .describe('One quarter.'),
      )
      .describe('Quarterly rows, most recent first.'),
    quarters_available: z
      .number()
      .int()
      .describe('Reported quarters in the requested window, before the quarters cap.'),
    data_as_of: z.string().describe('When FDIC last rebuilt the financials index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for an empty window, an inactive institution, or quarters left out by the cap.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more quarters were available than the quarters cap returned.'),
    shown: z.number().optional().describe('Quarters returned.'),
    cap: z.number().optional().describe('The quarters cap applied.'),
  },

  errors: [
    {
      reason: 'cert_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No institution record carries this CERT',
      recovery:
        'Look up the CERT with fdic_search_institutions by name, then call this tool again with that CERT.',
      severity: 'notice',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'from_date is after to_date',
      recovery: 'Set from_date on or before to_date, or omit one of them.',
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
    const from = input.from_date === undefined ? undefined : reportDateToIso(input.from_date);
    const to = input.to_date === undefined ? undefined : reportDateToIso(input.to_date);
    if (from && to && from > to) {
      throw ctx.fail('invalid_date_range', `from_date ${from} is after to_date ${to}.`, {
        ...ctx.recoveryFor('invalid_date_range'),
      });
    }
    const metrics = resolveMetrics(input.metrics);

    const service = getFdicService();
    const budget = callBudget();
    // Settled, not Promise.all: an unknown CERT is cert_not_found even when the
    // history call fails, never that call's rate limit.
    const [profileResult, historyResult] = await Promise.allSettled([
      service.getInstitution(input.cert, ctx, budget),
      service.getFinancialHistory(
        {
          cert: input.cert,
          metrics,
          limit: input.quarters,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
        ctx,
        budget,
      ),
    ]);
    if (profileResult.status === 'rejected') throw profileResult.reason;
    const inst = profileResult.value.institution;
    if (!inst) {
      throw ctx.fail('cert_not_found', `No FDIC institution record carries CERT ${input.cert}.`, {
        ...ctx.recoveryFor('cert_not_found'),
      });
    }
    if (historyResult.status === 'rejected') throw historyResult.reason;
    const history = historyResult.value;

    const notices: string[] = [];
    if (!inst.active) {
      const since = inst.ended_on ? `Inactive since ${inst.ended_on}` : 'Inactive';
      const last = inst.last_report_date
        ? `; its last report is ${inst.last_report_date}.`
        : '; no Call Report is on file for it.';
      const successor =
        inst.successor_cert !== undefined
          ? ` Successor CERT ${inst.successor_cert} continues the franchise.`
          : '';
      notices.push(`${since}${last}${successor}`);
    }
    if (history.rows.length === 0) {
      const window =
        from || to
          ? ` between ${from ?? 'the first quarter'} and ${to ?? 'the latest quarter'}`
          : '';
      const through = inst.last_report_date
        ? `; its reports run through ${inst.last_report_date}`
        : '';
      const widen = from || to ? ' Widen from_date/to_date or omit them.' : '';
      notices.push(`No Call Reports for CERT ${input.cert}${window}${through}.${widen}`);
    }
    const truncated = history.total > history.rows.length && history.rows.length > 0;
    if (truncated) {
      notices.push(
        `Showing the latest ${history.rows.length} of ${history.total} quarters; raise quarters or narrow from_date/to_date.`,
      );
      ctx.enrich.truncated({
        shown: history.rows.length,
        cap: input.quarters,
        guidance: notices.join(' '),
      });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Financial history', {
      cert: input.cert,
      quarters: history.rows.length,
      available: history.total,
    });

    return {
      institution: {
        cert: inst.cert,
        name: inst.name,
        active: inst.active,
        city: inst.city,
        state: inst.state,
        ...(inst.holding_company ? { holding_company: inst.holding_company } : {}),
        ...(inst.last_report_date ? { last_report_date: inst.last_report_date } : {}),
        ...(inst.ended_on ? { ended_on: inst.ended_on } : {}),
        ...(inst.successor_cert !== undefined ? { successor_cert: inst.successor_cert } : {}),
      },
      metric_definitions: metricDefinitions(metrics),
      rows: history.rows,
      quarters_available: history.total,
      data_as_of: history.dataAsOf,
    };
  },

  format: (result) => {
    const inst = result.institution;
    const lines = [
      `## ${inline(inst.name)} — CERT ${inst.cert}`,
      `${inst.active ? 'Active' : 'Inactive'} · ${inline(inst.city)}, ${inst.state}`,
    ];
    if (inst.holding_company) {
      const rssd =
        inst.holding_company.rssd !== undefined ? ` (RSSD ${inst.holding_company.rssd})` : '';
      lines.push(`Holding company: ${inline(inst.holding_company.name)}${rssd}`);
    }
    const lifecycle = [
      inst.last_report_date ? `last report ${inst.last_report_date}` : undefined,
      inst.ended_on ? `ended ${inst.ended_on}` : undefined,
      inst.successor_cert !== undefined ? `successor CERT ${inst.successor_cert}` : undefined,
    ].filter(Boolean);
    if (lifecycle.length) lines.push(lifecycle.join(' · '));
    lines.push(
      `${num(result.quarters_available)} quarters available in the window; ${result.rows.length} shown. Data as of ${result.data_as_of}.`,
    );

    const columns: string[] = [];
    for (const row of result.rows) {
      for (const key of Object.keys(row.values)) if (!columns.includes(key)) columns.push(key);
    }
    const units = new Map(result.metric_definitions.map((def) => [def.metric, def.unit]));
    if (result.rows.length) {
      lines.push('', `| Report date | ${columns.map(cell).join(' | ')} |`);
      lines.push(`|:--|${columns.map(() => '--:').join('|')}|`);
      for (const row of result.rows) {
        const values = columns.map((metric) => metricValue(row.values[metric], units.get(metric)));
        lines.push(`| ${row.report_date} | ${values.join(' | ')} |`);
      }
    }

    lines.push('', '**Metrics** (usd_thousands values are thousands of US dollars):');
    for (const def of result.metric_definitions) {
      const note = def.note ? ` — ${inline(def.note)}` : '';
      lines.push(
        `- ${def.metric}: field ${def.field} · unit ${def.unit} · basis ${def.basis}${note}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
