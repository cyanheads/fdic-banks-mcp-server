/**
 * @fileoverview fdic_get_institution_history — one institution's structure-change
 * events from BankFind `/history`, newest first: mergers on either side, failures
 * and assisted takeovers, branch purchases and sales, renames, relocations, and
 * charter changes, one event per exit.
 * @module mcp-server/tools/definitions/get-institution-history
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  EVENT_TYPES,
  type EventType,
  HISTORY_ROLES,
  type HistoryAttribute,
} from '@/services/fdic/change-codes.js';
import { callBudget, getFdicService, PANEL_BUDGET_MS } from '@/services/fdic/fdic-service.js';
import { isCalendarDate } from '@/services/fdic/query-builder.js';
import { blankAsUnset, calendarDateInput } from '../input-schemas.js';
import { cell, inline, num } from '../markdown.js';

/** Every type but `branch`: what an omitted `event_types` searches. */
const DEFAULT_EVENT_TYPES = EVENT_TYPES.filter((type) => type !== 'branch');

const ChangeSchema = z
  .object({
    from: z.string().describe('Value FDIC recorded before the change.'),
    to: z.string().describe('Value FDIC recorded after the change.'),
  })
  .describe('One attribute before and after.');

const EventSchema = z
  .object({
    effective_date: z.string().describe('Date the change took effect (YYYY-MM-DD).'),
    event_type: z
      .enum(EVENT_TYPES)
      .describe(
        "This server's class of the change code; fdic_list_reference topic change_codes maps each code.",
      ),
    change_code: z.number().int().describe('FDIC change code (CHANGECODE).'),
    change_description: z.string().describe("FDIC's label for the change code, verbatim."),
    role: z
      .enum(HISTORY_ROLES)
      .describe(
        "The institution's part: subject (a change to itself), outgoing (it ceased in this merger or failure), survivor (it absorbed the counterparty), buyer or seller (of branches).",
      ),
    counterparty: z
      .object({
        cert: z.number().int().optional().describe('CERT of the other institution, when recorded.'),
        name: z.string().optional().describe('Name of the other institution, as recorded.'),
      })
      .optional()
      .describe(
        'The other institution: the survivor for outgoing, the absorbed bank for survivor, the seller for buyer, the buyer for seller, the former certificate for a code 150 CERT change. Absent when FDIC recorded none.',
      ),
    changes: z
      .object({
        name: ChangeSchema.optional().describe('Legal name, or office name on a branch event.'),
        address: ChangeSchema.optional().describe('Street address.'),
        city: ChangeSchema.optional().describe('City.'),
        state: ChangeSchema.optional().describe('State postal code.'),
        bank_class: ChangeSchema.optional().describe(
          'Charter class code, e.g. NM; FDIC also records CU and NS here.',
        ),
        chartering_agency: ChangeSchema.optional().describe(
          'Chartering agency, e.g. STATE or OCC.',
        ),
        regulator: ChangeSchema.optional().describe('Primary federal regulator, e.g. FDIC or FED.'),
      } satisfies Record<HistoryAttribute, unknown>)
      .optional()
      .describe(
        'Attributes whose former and new values FDIC both recorded and that differ: name, address, city, state, bank_class, chartering_agency, regulator. Subject and branch events only; absent when none changed.',
      ),
    branch: z
      .object({
        name: z.string().optional().describe('Office name.'),
        number: z.number().int().optional().describe('Office number within the institution.'),
        address: z.string().optional().describe('Street address.'),
        city: z.string().optional().describe('City.'),
        state: z.string().optional().describe('State postal code.'),
      })
      .optional()
      .describe('The office a branch event concerns, as it stood after the change.'),
    transaction_number: z
      .number()
      .int()
      .optional()
      .describe('FDIC transaction number (TRANSNUM); rows of one transaction share it.'),
  })
  .describe('One structure-change event.');

export const getInstitutionHistoryTool = tool('fdic_get_institution_history', {
  title: 'Get institution structure-change history',
  description:
    "Get one institution's structure-change history by CERT, newest first: the mergers it absorbed or was absorbed in, failures and assisted takeovers, branch purchases and sales, renames, relocations, charter and regulator changes, openings, and closings, each with its effective date, FDIC change code, the institution's role, and the other institution's CERT and name. A merger or failure appears once, from whichever side the CERT was on. Branch-level openings, closings, sales, and relocations are left out unless event_types includes branch. Merger records start in 1969 and failure records in 1970.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    cert: z
      .number()
      .int()
      .min(1)
      .describe('FDIC certificate number, from fdic_search_institutions.'),
    event_types: z
      .array(z.enum(EVENT_TYPES).describe('Event type.'))
      .min(1, 'Provide at least one event type, or omit event_types for every type but branch.')
      .max(1000)
      .optional()
      .describe(
        'Nonempty selection of at most 1000 event types, deduplicated: merger, failure_or_assistance, branch_purchase, name_change, relocation, charter_change, opening, closing, other (a change code this server has not classified), branch (branch-level openings, closings, sales, and relocations). Omit for every type but branch; echoed as event_types_filter.',
      ),
    from_date: calendarDateInput(
      'Earliest effective date to include (YYYY-MM-DD, e.g. 2008-01-01).',
    ),
    to_date: calendarDateInput('Latest effective date to include (YYYY-MM-DD).'),
    limit: blankAsUnset(z.number().int().min(1).default(50)).describe(
      'Events per page, at least 1. The whole matching history is read, so any limit is served; use next_offset to continue.',
    ),
    offset: blankAsUnset(z.number().int().min(0).default(0)).describe(
      'Events to skip; pass next_offset from the previous page.',
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
      .describe('The institution record for the CERT.'),
    events: z.array(EventSchema).describe('Events on this page, newest first.'),
    total: z.number().int().describe('Events matching the filters across all pages.'),
    next_offset: z
      .number()
      .int()
      .optional()
      .describe('Offset of the next page; present when more events remain.'),
    event_types_filter: z
      .array(z.enum(EVENT_TYPES).describe('Event type.'))
      .describe('The event types searched, after the default and deduplication.'),
    data_as_of: z.string().describe('When FDIC last rebuilt the history index (ISO timestamp).'),
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
      reason: 'cert_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No institution record carries this CERT',
      recovery:
        'Look up the CERT with fdic_search_institutions by name, then call this tool again with that CERT.',
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
    // explicit selection from the default.
    const eventTypes: EventType[] = input.event_types
      ? [...new Set(input.event_types)]
      : [...DEFAULT_EVENT_TYPES];

    const service = getFdicService();
    // Branch history pages through tens of thousands of rows; one budget spans every request.
    const budget = eventTypes.includes('branch') ? callBudget(PANEL_BUDGET_MS) : callBudget();
    // Settled, not Promise.all: an unknown CERT is cert_not_found even when the
    // history read fails, never that read's rate limit.
    const [profileResult, historyResult] = await Promise.allSettled([
      service.getInstitution(input.cert, ctx, budget),
      service.getInstitutionHistory(
        {
          cert: input.cert,
          eventTypes,
          ...(input.from_date ? { from: input.from_date } : {}),
          ...(input.to_date ? { to: input.to_date } : {}),
        },
        ctx,
        budget,
      ),
    ]);
    if (profileResult.status === 'rejected') throw profileResult.reason;
    const inst = profileResult.value.institution;
    if (!inst) {
      throw ctx.fail('cert_not_found', `No FDIC institution record carries CERT ${input.cert}.`);
    }
    if (historyResult.status === 'rejected') throw historyResult.reason;
    const history = historyResult.value;

    const total = history.events.length;
    const events = history.events.slice(input.offset, input.offset + input.limit);
    const end = input.offset + events.length;
    const hasMore = end < total;

    if (total === 0) {
      const fragments = [`No events for CERT ${input.cert}.`];
      fragments.push(
        input.event_types
          ? `Only ${eventTypes.join(', ')} events were searched; omit event_types for every type but branch.`
          : 'Branch events are left out by default; add branch to event_types to include them.',
      );
      if (input.from_date || input.to_date) {
        fragments.push(
          "Dates match each event's effective date; widen from_date/to_date or omit them.",
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    } else if (events.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the last of ${total} events; lower offset or omit it.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: events.length,
        cap: input.limit,
        guidance: `Showing events ${input.offset + 1}–${end} of ${total}, newest first; pass offset ${end} for the next page.`,
      });
    }

    ctx.log.info('Institution history', { cert: input.cert, total, returned: events.length });

    return {
      institution: {
        cert: inst.cert,
        name: inst.name,
        active: inst.active,
        city: inst.city,
        state: inst.state,
        ...(inst.ended_on ? { ended_on: inst.ended_on } : {}),
        ...(inst.successor_cert !== undefined ? { successor_cert: inst.successor_cert } : {}),
      },
      events,
      total,
      ...(hasMore ? { next_offset: end } : {}),
      event_types_filter: eventTypes,
      data_as_of: history.dataAsOf,
    };
  },

  format: (result) => {
    const inst = result.institution;
    const status = [
      inst.active ? 'Active' : 'Inactive',
      `${inline(inst.city)}, ${inst.state}`,
      inst.ended_on ? `ended ${inst.ended_on}` : undefined,
      inst.successor_cert !== undefined ? `successor CERT ${inst.successor_cert}` : undefined,
    ].filter(Boolean);
    const lines = [
      `## ${inline(inst.name)} — CERT ${inst.cert}`,
      status.join(' · '),
      `${num(result.total)} ${result.total === 1 ? 'event' : 'events'} of types ${result.event_types_filter.join(', ')}; ${result.events.length} shown, newest first. Data as of ${result.data_as_of}.`,
    ];
    if (result.next_offset !== undefined) lines.push(`Next page: offset ${result.next_offset}.`);
    if (result.events.length) {
      lines.push(
        '',
        '| Date | Type | Code | Description | Role | Counterparty | Changes or branch | Transaction |',
        '|:--|:--|--:|:--|:--|:--|:--|--:|',
      );
      for (const e of result.events) {
        const cp = e.counterparty;
        const counterparty = cp
          ? [
              cp.name !== undefined ? cell(cp.name) : undefined,
              cp.cert !== undefined ? `CERT ${cp.cert}` : undefined,
            ]
              .filter(Boolean)
              .join(' · ')
          : '—';
        const detail: string[] = [];
        if (e.branch) {
          const office = [
            e.branch.number !== undefined ? `office ${e.branch.number}` : undefined,
            e.branch.name !== undefined ? cell(e.branch.name) : undefined,
            e.branch.address !== undefined ? cell(e.branch.address) : undefined,
            e.branch.city !== undefined ? cell(e.branch.city) : undefined,
            e.branch.state !== undefined ? cell(e.branch.state) : undefined,
          ].filter(Boolean);
          detail.push(`branch: ${office.join(', ')}`);
        }
        for (const [attribute, change] of Object.entries(e.changes ?? {})) {
          if (change) detail.push(`${attribute}: ${cell(change.from)} → ${cell(change.to)}`);
        }
        lines.push(
          `| ${e.effective_date} | ${e.event_type} | ${e.change_code} | ${cell(e.change_description)} | ${e.role} | ${counterparty} | ${detail.length ? detail.join('; ') : '—'} | ${e.transaction_number ?? '—'} |`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
