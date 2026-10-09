/**
 * @fileoverview fdic_search_failures — bank failures and assistance transactions
 * since 1934, with totals over every matching event, per-method subtotals, and
 * optional grouping by year, state, method, or insurance fund. Loss totals never
 * read a missing FDIC estimate as zero.
 * @module mcp-server/tools/definitions/search-failures
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { FAILURE_METHOD_CODES, failureMethodLabel } from '@/services/fdic/failure-methods.js';
import { callBudget, getFdicService } from '@/services/fdic/fdic-service.js';
import { isCalendarDate, nameTokens as tokenize } from '@/services/fdic/query-builder.js';
import type { FailureBucket, FailureFilters } from '@/services/fdic/types.js';
import { normalizeState } from '@/services/fdic/us-states.js';
import { blankAsUnset, calendarDateInput, stateInput } from '../input-schemas.js';
import { cell, inline, num } from '../markdown.js';

const RESOLUTIONS = ['failure', 'assistance', 'all'] as const;
const GROUP_BY = ['year', 'state', 'method', 'insurance_fund'] as const;
const SORTS = ['date_desc', 'date_asc', 'loss_desc', 'assets_desc'] as const;

/** `null` when every event in a non-empty set lacks an estimate: FDIC sums those to 0. */
function lossTotal(count: number, sum: number, missing: number): number | null {
  return count > 0 && missing === count ? null : sum;
}

/** A loss total for display: "no estimate" in place of a fabricated zero. */
function loss(value: number | null): string {
  return value === null ? 'no estimate' : num(value);
}

const TotalsFields = {
  count: z.number().int().describe('Matching events.'),
  total_assets: z
    .number()
    .describe(
      'Sum of total assets at the last report before failure, USD thousands; events with no recorded figure add nothing.',
    ),
  estimated_loss_total: z
    .number()
    .nullable()
    .describe(
      'Sum of FDIC estimated losses over events that have an estimate, USD thousands; null when none of them has one.',
    ),
  estimated_loss_missing_count: z
    .number()
    .int()
    .describe('Events without an FDIC loss estimate — estimated_loss_total covers only the rest.'),
};

export const searchFailuresTool = tool('fdic_search_failures', {
  title: 'Search FDIC bank failures',
  description:
    "Search FDIC-insured bank failures and assistance transactions since 1934 by name, CERT, headquarters state, failure date range, resolution method, or size. Returns each event with failure date, acquirer, total assets and deposits, and the FDIC's estimated loss to the insurance fund, plus totals over every matching event; group_by adds counts and losses per year, state, method, or fund. Searches failures only unless resolution is set to assistance or all. Dollar amounts are in thousands.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    name: blankAsUnset(z.string().max(100).optional()).describe(
      'Failed institution name, up to 100 characters; every word of two or more letters or digits must appear in the name FDIC recorded (e.g. "silicon valley"). Case-insensitive. A standalone NA is ignored beside other words, so it also finds names recorded with N.A.',
    ),
    certs: z
      .array(z.number().int().min(1).describe('FDIC certificate number.'))
      .max(50)
      .optional()
      .describe('Up to 50 CERTs of failed institutions. Events before 1977 carry no CERT.'),
    state: stateInput(
      "Failed institution's headquarters state: two-letter code in any case or full name.",
    ),
    from_date: calendarDateInput('Earliest failure date to include (YYYY-MM-DD, e.g. 2023-03-10).'),
    to_date: calendarDateInput('Latest failure date to include (YYYY-MM-DD).'),
    resolution: blankAsUnset(z.enum(RESOLUTIONS).optional()).describe(
      'failure (default), assistance (open-bank assistance and similar transactions), or all. Echoed as resolution_filter.',
    ),
    methods: z
      .array(
        z
          .enum(FAILURE_METHOD_CODES)
          .describe(
            'Resolution method code, uppercase; fdic_list_reference topic failure_methods lists them.',
          ),
      )
      .max(FAILURE_METHOD_CODES.length)
      .optional()
      .describe(
        'How each event was resolved: PA purchase and assumption of all deposits, PI P&A of insured deposits only, P&A P&A with deposit scope undetermined, IDT insured deposit transfer, ABT asset-backed transfer, PO payout, DINB payout through a Deposit Insurance National Bank, A/A assistance transaction, REP reprivatization, MGR FSLIC management takeover, OBAM undocumented assistance code.',
      ),
    min_assets: blankAsUnset(z.number().min(0).optional()).describe(
      'Minimum total assets at the last report before failure, in thousands of US dollars.',
    ),
    group_by: blankAsUnset(z.enum(GROUP_BY).optional()).describe(
      'Add counts, assets, deposits, and estimated losses per year, state, method, or insurance_fund over every matching event.',
    ),
    sort: blankAsUnset(z.enum(SORTS).default('date_desc')).describe(
      'date_desc (newest first, default), date_asc, loss_desc (largest estimated loss first), or assets_desc.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(200).default(25)).describe(
      'Events per page (1–200).',
    ),
    offset: blankAsUnset(z.number().int().min(0).max(100_000).default(0)).describe(
      'Events to skip (0–100,000); pass next_offset from the previous page.',
    ),
  }),

  output: z.object({
    failures: z
      .array(
        z
          .object({
            failure_id: z.string().describe('FDIC failure record ID.'),
            cert: z
              .number()
              .int()
              .optional()
              .describe('CERT of the failed institution; absent before 1977.'),
            fin: z
              .string()
              .optional()
              .describe('FDIC financial institution number, when recorded.'),
            name: z.string().describe('Failed institution name as FDIC recorded it.'),
            city: z.string().describe('Headquarters city.'),
            state: z.string().describe('Headquarters state postal code.'),
            failed_on: z.string().describe('Failure or assistance date (YYYY-MM-DD).'),
            resolved_on: z
              .string()
              .optional()
              .describe('Resolution date (YYYY-MM-DD); absent when FDIC recorded none.'),
            resolution: z.string().describe('FAILURE or ASSISTANCE.'),
            method: z
              .string()
              .describe(
                'Resolution method code, e.g. PA, PO, A/A; fdic_list_reference topic failure_methods lists the codes.',
              ),
            method_label: z.string().describe('What the method code means.'),
            insurance_fund: z
              .string()
              .describe('Fund that bore the cost: DIF, BIF, SAIF, RTC, FSLIC, or FDIC.'),
            charter_class: z
              .string()
              .describe(
                'Charter class code of the failed institution — a bank_classes code (fdic_list_reference topic bank_classes), or MI on a few savings-bank records from before 1984.',
              ),
            total_assets: z
              .number()
              .optional()
              .describe(
                'Total assets at the last report before failure, USD thousands; absent when not recorded.',
              ),
            total_deposits: z
              .number()
              .optional()
              .describe(
                'Total deposits at the last report before failure, USD thousands; absent when not recorded.',
              ),
            estimated_loss: z
              .number()
              .optional()
              .describe(
                'FDIC estimated loss to the insurance fund, USD thousands; absent when FDIC has no estimate (0 is a real value).',
              ),
            estimated_loss_as_of: z
              .string()
              .optional()
              .describe(
                'Date of the most recent loss estimate (YYYY-MM-DD); absent when FDIC recorded none.',
              ),
            acquirer: z
              .object({
                name: z.string().describe('Acquiring institution name.'),
                city: z.string().optional().describe('Acquirer city.'),
                state: z.string().optional().describe('Acquirer state postal code.'),
              })
              .optional()
              .describe('Acquiring institution; absent for payouts and assistance without one.'),
          })
          .describe(
            'One failure or assistance event; an optional field is absent when FDIC recorded no value for it.',
          ),
      )
      .describe('Matching events for this page.'),
    summary: z
      .object({
        ...TotalsFields,
        total_deposits: z.number().describe('Sum of total deposits, USD thousands.'),
        by_method: z
          .array(
            z
              .object({
                method: z.string().describe('Resolution method code.'),
                method_label: z.string().describe('What the method code means.'),
                ...TotalsFields,
              })
              .describe('Totals for one method.'),
          )
          .describe('Totals per resolution method, largest count first.'),
      })
      .describe('Totals over every matching event, not just this page.'),
    groups: z
      .array(
        z
          .object({
            key: z.string().describe('Year, state code, method code, or fund.'),
            ...TotalsFields,
            total_deposits: z.number().describe('Sum of total deposits, USD thousands.'),
          })
          .describe('Totals for one group.'),
      )
      .optional()
      .describe(
        'Present with group_by. Years run ascending with empty years filled in; other keys by count, largest first.',
      ),
    resolution_filter: z.enum(RESOLUTIONS).describe('The resolution filter applied.'),
    total: z.number().int().describe('Matching events across all pages.'),
    next_offset: z
      .number()
      .int()
      .optional()
      .describe('Offset of the next page; present when more events remain.'),
    data_as_of: z.string().describe('When FDIC last rebuilt the failures index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, the page is past the end, or more pages remain.'),
    truncated: z.boolean().optional().describe('True when more events remain beyond this page.'),
    shown: z.number().optional().describe('Events returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
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
      reason: 'invalid_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'name has no word of two or more letters or digits',
      recovery:
        "Use at least one word of two or more characters, or pass the institution's CERT in certs.",
      severity: 'notice',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'from_date or to_date names a day its month does not have',
      recovery: 'Pass a real calendar date as YYYY-MM-DD, such as 2023-03-10.',
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
    const state = input.state === undefined ? undefined : normalizeState(input.state);
    if (input.state !== undefined && state === undefined) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a US state, DC, or territory.`);
    }
    const nameTokens = input.name === undefined ? undefined : tokenize(input.name);
    if (nameTokens !== undefined && nameTokens.length === 0) {
      throw ctx.fail('invalid_name', 'name has no word of two or more letters or digits.');
    }
    for (const date of [input.from_date, input.to_date]) {
      if (date !== undefined && !isCalendarDate(date)) {
        throw ctx.fail('invalid_date', `${date} is not a real calendar date.`);
      }
    }
    if (input.from_date && input.to_date && input.from_date > input.to_date) {
      throw ctx.fail(
        'invalid_date_range',
        `from_date ${input.from_date} is after to_date ${input.to_date}.`,
      );
    }

    // Defaulted here, not in the schema, so the zero-hit notice can tell an
    // explicit resolution failure from the default.
    const resolution = input.resolution ?? 'failure';
    const filters: FailureFilters = {
      resolution,
      ...(nameTokens ? { nameTokens } : {}),
      ...(input.certs?.length ? { certs: [...new Set(input.certs)] } : {}),
      ...(state ? { state } : {}),
      ...(input.from_date ? { from: input.from_date } : {}),
      ...(input.to_date ? { to: input.to_date } : {}),
      ...(input.methods?.length ? { methods: input.methods } : {}),
      // A minimum of 0 bounds nothing; as a range clause it would also drop events with no recorded assets.
      ...(input.min_assets ? { minAssets: input.min_assets } : {}),
    };
    const groupBy = input.group_by;

    const service = getFdicService();
    const budget = callBudget();
    const [page, missingByMethod, grouped, groupedMissing] = await Promise.all([
      service.searchFailures(
        filters,
        { sort: input.sort, limit: input.limit, offset: input.offset },
        ctx,
        budget,
      ),
      service.aggregateFailures(filters, 'method', { missingCostOnly: true }, ctx, budget),
      groupBy
        ? service.aggregateFailures(filters, groupBy, { missingCostOnly: false }, ctx, budget)
        : undefined,
      groupBy && groupBy !== 'method'
        ? service.aggregateFailures(filters, groupBy, { missingCostOnly: true }, ctx, budget)
        : undefined,
    ]);

    const missingForMethod = new Map(missingByMethod.buckets.map((b) => [b.key, b.count]));
    const summary = {
      count: page.totals.count,
      total_assets: page.totals.assets,
      total_deposits: page.totals.deposits,
      estimated_loss_total: lossTotal(page.totals.count, page.totals.cost, missingByMethod.total),
      estimated_loss_missing_count: missingByMethod.total,
      by_method: page.byMethod
        .toSorted((a, b) => b.count - a.count)
        .map((b) => {
          const missing = missingForMethod.get(b.key) ?? 0;
          return {
            method: b.key,
            method_label: failureMethodLabel(b.key),
            count: b.count,
            total_assets: b.assets,
            estimated_loss_total: lossTotal(b.count, b.cost, missing),
            estimated_loss_missing_count: missing,
          };
        }),
    };

    let groups: ReturnType<typeof toGroup>[] | undefined;
    if (grouped && groupBy) {
      const missingForGroup = groupedMissing
        ? new Map(groupedMissing.buckets.map((b) => [b.key, b.count]))
        : missingForMethod;
      const buckets =
        groupBy === 'year'
          ? fillYears(grouped.buckets)
          : grouped.buckets.toSorted((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      groups = buckets.map((b) => toGroup(b, missingForGroup.get(b.key) ?? 0));
    }

    const end = input.offset + page.rows.length;
    const hasMore = end < page.total;

    if (page.total === 0) {
      const fragments: string[] = [];
      if (input.resolution === undefined) {
        fragments.push(
          'Only failures were searched; set resolution to all to include assistance transactions such as open-bank assistance.',
        );
      }
      if (nameTokens) {
        fragments.push(
          "Failure names are matched word by word against FDIC's records; try fewer words, or find the institution's CERT with fdic_search_institutions and pass certs.",
        );
      }
      if (input.from_date || input.to_date) {
        // Best-effort: the search itself succeeded, so a shed or throttled
        // lookup only drops the date from the notice.
        const latest = await service.latestFailureDate(ctx, budget).catch((err: unknown) => {
          if (ctx.signal.aborted) throw err;
          ctx.log.warning('Latest failure date lookup failed; the notice omits it', {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        });
        fragments.push(
          `Failure records run from 1934 through ${latest ?? 'the latest recorded event'}; widen from_date/to_date.`,
        );
      }
      if (state) fragments.push("state is the failed institution's headquarters state.");
      if (input.methods?.length) {
        fragments.push(
          'methods narrows to how each event was resolved; fdic_list_reference with topic failure_methods lists the codes.',
        );
      }
      ctx.enrich.notice(
        fragments.length ? fragments.join(' ') : 'No events matched these filters.',
      );
    } else if (page.rows.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the last of ${page.total} matching events; lower offset or omit it.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: page.rows.length,
        cap: input.limit,
        guidance: `Showing events ${input.offset + 1}–${end} of ${page.total}; pass offset ${end} for the next page. summary covers every matching event.`,
      });
    }

    ctx.log.info('Failure search', { total: page.total, returned: page.rows.length, groupBy });

    return {
      failures: page.rows,
      summary,
      ...(groups ? { groups } : {}),
      resolution_filter: resolution,
      total: page.total,
      ...(hasMore ? { next_offset: end } : {}),
      data_as_of: page.dataAsOf,
    };
  },

  format: (result) => {
    const s = result.summary;
    const lines = [
      `## ${num(s.count)} ${result.resolution_filter === 'all' ? 'failure and assistance' : result.resolution_filter} events`,
      `Data as of ${result.data_as_of}. Dollar amounts are thousands of US dollars. Total matching: ${num(result.total)}.`,
      `**Summary:** total assets ${num(s.total_assets)} · total deposits ${num(s.total_deposits)} · estimated loss ${loss(s.estimated_loss_total)} (${num(s.estimated_loss_missing_count)} events without an estimate, not counted)`,
    ];
    if (result.next_offset !== undefined) lines.push(`Next page: offset ${result.next_offset}.`);

    if (s.by_method.length) {
      lines.push(
        '',
        '| Method | Label | Events | Total assets | Estimated loss | Without estimate |',
      );
      lines.push('|:--|:--|--:|--:|--:|--:|');
      for (const m of s.by_method) {
        lines.push(
          `| ${cell(m.method)} | ${cell(m.method_label)} | ${num(m.count)} | ${num(m.total_assets)} | ${loss(m.estimated_loss_total)} | ${num(m.estimated_loss_missing_count)} |`,
        );
      }
    }

    if (result.groups) {
      lines.push(
        '',
        '| Group | Events | Total assets | Total deposits | Estimated loss | Without estimate |',
      );
      lines.push('|:--|--:|--:|--:|--:|--:|');
      for (const g of result.groups) {
        lines.push(
          `| ${cell(g.key)} | ${num(g.count)} | ${num(g.total_assets)} | ${num(g.total_deposits)} | ${loss(g.estimated_loss_total)} | ${num(g.estimated_loss_missing_count)} |`,
        );
      }
    }

    for (const f of result.failures) {
      lines.push('', `### ${inline(f.name)} — ${inline(f.city)}, ${f.state} · ${f.failed_on}`);
      const ids = [
        `failure ID ${f.failure_id}`,
        f.cert !== undefined ? `CERT ${f.cert}` : 'no CERT',
        f.fin ? `FIN ${f.fin}` : undefined,
        `charter class ${f.charter_class}`,
      ].filter(Boolean);
      lines.push(`- ${ids.join(' · ')}`);
      const resolved = f.resolved_on ? `, resolved ${f.resolved_on}` : '';
      lines.push(
        `- ${f.resolution} by ${f.method} (${inline(f.method_label)})${resolved} · fund ${f.insurance_fund}`,
      );
      const lossText =
        f.estimated_loss !== undefined
          ? `estimated loss ${num(f.estimated_loss)}${f.estimated_loss_as_of ? ` as of ${f.estimated_loss_as_of}` : ''}`
          : 'no loss estimate';
      lines.push(
        `- Total assets ${num(f.total_assets)} · total deposits ${num(f.total_deposits)} · ${lossText}`,
      );
      if (f.acquirer) {
        const where = [f.acquirer.city, f.acquirer.state]
          .filter((part): part is string => part !== undefined)
          .map(inline);
        lines.push(
          `- Acquirer: ${inline(f.acquirer.name)}${where.length ? `, ${where.join(', ')}` : ''}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function toGroup(b: FailureBucket, missing: number) {
  return {
    key: b.key,
    count: b.count,
    total_assets: b.assets,
    total_deposits: b.deposits,
    estimated_loss_total: lossTotal(b.count, b.cost, missing),
    estimated_loss_missing_count: missing,
  };
}

/** Year buckets ascending, with the empty years FDIC omits filled in across the span. */
function fillYears(buckets: readonly FailureBucket[]): FailureBucket[] {
  const byYear = new Map(buckets.map((b) => [Number(b.key), b]));
  const years = [...byYear.keys()].filter(Number.isFinite);
  if (years.length === 0) return [];
  const filled: FailureBucket[] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year++) {
    filled.push(
      byYear.get(year) ?? { key: String(year), count: 0, assets: 0, deposits: 0, cost: 0 },
    );
  }
  return filled;
}
