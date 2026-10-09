/**
 * @fileoverview fdic_search_institutions — find FDIC-insured institutions, active or
 * not, by name, CERT, location, size, charter class, or holding company. The entry
 * point: every other data tool takes the CERT it returns.
 * @module mcp-server/tools/definitions/search-institutions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { BANK_CLASS_CODES } from '@/services/fdic/bank-classes.js';
import { callBudget, getFdicService } from '@/services/fdic/fdic-service.js';
import { normalizeInstitutionName } from '@/services/fdic/query-builder.js';
import type { InstitutionStatus } from '@/services/fdic/types.js';
import { normalizeState } from '@/services/fdic/us-states.js';
import { blankAsUnset, stateInput } from '../input-schemas.js';
import { inline, num } from '../markdown.js';

const STATUSES = ['active', 'inactive', 'any'] as const;

/** "credit union", "FCU", or a trailing "CU" in a name query. */
const CREDIT_UNION_PATTERN = /credit\s+union|\bfcu\b|\bcu\s*$/i;

const InstitutionSchema = z
  .object({
    cert: z
      .number()
      .int()
      .describe('FDIC certificate number (CERT) — the key every other fdic_ tool takes.'),
    name: z
      .string()
      .describe('Current legal name; for an inactive institution, its name at closing.'),
    active: z
      .boolean()
      .describe(
        'True while the charter is open and insured; false after a merger, failure, or closing.',
      ),
    city: z.string().describe('Headquarters city.'),
    state: z.string().describe('Headquarters state postal code.'),
    county: z.string().optional().describe('Headquarters county.'),
    bank_class: z
      .object({
        code: z.string().describe('FDIC charter class code, e.g. N, NM, SM, SB.'),
        label: z.string().describe('What the class code means.'),
      })
      .describe('Charter class; fdic_list_reference topic bank_classes lists every code.'),
    regulator: z.string().optional().describe('Primary federal regulator, e.g. OCC, FED, FDIC.'),
    established_on: z
      .string()
      .optional()
      .describe('Date the institution was established (YYYY-MM-DD).'),
    insured_since: z.string().optional().describe('Date FDIC insurance began (YYYY-MM-DD).'),
    ended_on: z
      .string()
      .optional()
      .describe(
        'Date the charter ended by merger, failure, or closing (YYYY-MM-DD); inactive only.',
      ),
    successor_cert: z
      .number()
      .int()
      .optional()
      .describe('CERT of the institution that continued the franchise after a merger or failure.'),
    holding_company: z
      .object({
        name: z.string().describe('Top-tier holding company name.'),
        rssd: z
          .number()
          .int()
          .optional()
          .describe(
            'Federal Reserve RSSD ID of the holding company; pass as holding_company_rssd.',
          ),
      })
      .optional()
      .describe('Top-tier holding company; absent when the institution has none on record.'),
    fed_rssd: z.number().int().optional().describe('Federal Reserve RSSD ID of the institution.'),
    total_assets: z
      .number()
      .optional()
      .describe(
        'Total assets at the latest report (last report before closing if inactive), USD thousands.',
      ),
    total_deposits: z
      .number()
      .optional()
      .describe('Total deposits at the latest report, USD thousands.'),
    domestic_offices: z.number().optional().describe('Domestic offices at the latest report.'),
    last_report_date: z
      .string()
      .optional()
      .describe('Quarter-end date of the latest Call Report on file (YYYY-MM-DD).'),
    matched_on: z
      .object({
        field: z
          .enum(['former_name', 'trade_name'])
          .describe('Which kind of name matched the query.'),
        text: z.string().describe('The matched former or trade name.'),
      })
      .optional()
      .describe(
        'Present when a name search matched a former name or trade name rather than the current name.',
      ),
  })
  .describe('One institution record; an optional field is absent when FDIC holds no value for it.');

export const searchInstitutionsTool = tool('fdic_search_institutions', {
  title: 'Search FDIC-insured institutions',
  description:
    'Find FDIC-insured banks and savings institutions by name, CERT, location, size, charter class, or holding company — including closed, merged, and failed institutions. Name matching is fuzzy, case-insensitive, and also matches former and trade names (a result says which it matched); every word must match. Returns institution records keyed by CERT, the FDIC certificate number every other fdic_ tool takes, with active status, successor CERT for merged or failed institutions, holding company, and latest reported assets and deposits. Credit unions are insured by the NCUA and are not in this data.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    name: blankAsUnset(z.string().max(100).optional()).describe(
      'Institution name to match, up to 100 characters — current, former, or trade name, case-insensitive, every word required (e.g. "silicon valley"). Punctuation other than & \' . , - is ignored, and so is a standalone N.A. or NA, which then also matches "National Association".',
    ),
    certs: z
      .array(z.number().int().min(1).describe('FDIC certificate number.'))
      .max(50)
      .optional()
      .describe(
        'Exact lookup by up to 50 CERTs; requested CERTs with no record come back in missing_certs.',
      ),
    state: stateInput(
      'Headquarters state: two-letter code in any case (wa) or full name (Washington); DC and territories accepted.',
    ),
    city: blankAsUnset(z.string().max(50).optional()).describe(
      "Headquarters city as FDIC spells it (e.g. Seattle, St. Louis), up to 50 characters; matched exactly, as given or in title case, with a hyphen, apostrophe, or space between words also tried the other ways FDIC records it (Winston-Salem finds Winston Salem, Coeur d'Alene finds Coeur D Alene).",
    ),
    status: blankAsUnset(z.enum(STATUSES).optional()).describe(
      'active, inactive (merged, failed, or closed), or any. Default: any when name or certs is given, otherwise active. The applied value is echoed as status_filter.',
    ),
    bank_classes: z
      .array(
        z
          .enum(BANK_CLASS_CODES)
          .describe(
            'Charter class code, uppercase; fdic_list_reference topic bank_classes lists them.',
          ),
      )
      .max(8)
      .optional()
      .describe(
        'Charter classes to include: N national bank, NM state nonmember bank, SM state member bank, SB federal savings bank, SI state savings bank, SL state savings and loan, OI insured branch of a foreign bank, NC noninsured non-deposit trust company.',
      ),
    min_assets: blankAsUnset(z.number().min(0).optional()).describe(
      'Minimum latest reported total assets, in thousands of US dollars (1000000 = $1 billion).',
    ),
    max_assets: blankAsUnset(z.number().min(0).optional()).describe(
      'Maximum latest reported total assets, in thousands of US dollars.',
    ),
    holding_company_rssd: blankAsUnset(z.number().int().min(1).optional()).describe(
      "Holding company RSSD ID from any result's holding_company.rssd; lists the institutions under that top holder. With status any, former subsidiaries are included under the holder they had at closing.",
    ),
    sort: blankAsUnset(z.enum(['relevance', 'assets_desc', 'name']).optional()).describe(
      'relevance (active institutions whose current name holds every word of name first, then every other match, each by match score; default when name is given — without name it falls back to assets_desc), assets_desc (largest first; the default otherwise), or name (A–Z).',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(100).default(20)).describe(
      'Institutions per page (1–100).',
    ),
    offset: blankAsUnset(z.number().int().min(0).max(100_000).default(0)).describe(
      'Matches to skip (0–100,000); pass next_offset from the previous page.',
    ),
  }),

  output: z.object({
    institutions: z.array(InstitutionSchema).describe('Matching institutions for this page.'),
    status_filter: z.enum(STATUSES).describe('The status filter applied.'),
    total: z.number().int().describe('Institutions matching the filters across all pages.'),
    next_offset: z
      .number()
      .int()
      .optional()
      .describe('Offset of the next page; present when more matches remain.'),
    missing_certs: z
      .array(z.number().int().describe('A requested CERT with no institution record.'))
      .optional()
      .describe('Requested CERTs that match no institution record.'),
    data_as_of: z
      .string()
      .describe('When FDIC last rebuilt the institutions index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, the page is past the end, or more pages remain.'),
    truncated: z.boolean().optional().describe('True when more matches remain beyond this page.'),
    shown: z.number().optional().describe('Institutions returned on this page.'),
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
      reason: 'invalid_asset_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'min_assets exceeds max_assets',
      recovery: 'Set min_assets at or below max_assets, both in thousands of dollars.',
      severity: 'notice',
    },
    {
      reason: 'invalid_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'name has no letter or digit once normalized',
      recovery:
        'Include at least one letter or digit in name, or search by certs, state, or city instead.',
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
    const name = input.name === undefined ? undefined : normalizeInstitutionName(input.name);
    if (input.name !== undefined && name === undefined) {
      throw ctx.fail('invalid_name', 'name has no letter or digit to match on.');
    }
    if (
      input.min_assets !== undefined &&
      input.max_assets !== undefined &&
      input.min_assets > input.max_assets
    ) {
      throw ctx.fail(
        'invalid_asset_range',
        `min_assets (${input.min_assets}) exceeds max_assets (${input.max_assets}).`,
      );
    }

    const certs = input.certs?.length ? [...new Set(input.certs)] : undefined;
    const bankClasses = input.bank_classes?.length ? input.bank_classes : undefined;
    // A minimum of 0 bounds nothing; as a range clause it would also drop records with no recorded assets.
    const minAssets = input.min_assets || undefined;
    const lookup = name !== undefined || certs !== undefined;
    const status: InstitutionStatus = input.status ?? (lookup ? 'any' : 'active');
    // Relevance needs a name to score against; without one it falls back to size order.
    const requestedSort = input.sort ?? (name ? 'relevance' : 'assets_desc');
    const sort = requestedSort === 'relevance' && !name ? 'assets_desc' : requestedSort;

    const query = {
      ...(name ? { name } : {}),
      ...(certs ? { certs } : {}),
      ...(state ? { state } : {}),
      ...(input.city ? { city: input.city } : {}),
      status,
      ...(bankClasses ? { bankClasses } : {}),
      ...(minAssets !== undefined ? { minAssets } : {}),
      ...(input.max_assets !== undefined ? { maxAssets: input.max_assets } : {}),
      ...(input.holding_company_rssd !== undefined
        ? { holdingCompanyRssd: input.holding_company_rssd }
        : {}),
      sort,
      limit: input.limit,
      offset: input.offset,
    };

    // The page alone proves which CERTs exist only when nothing else narrows the
    // match and the whole match set fits on it; otherwise ask separately.
    const narrowed =
      name !== undefined ||
      state !== undefined ||
      input.city !== undefined ||
      status !== 'any' ||
      bankClasses !== undefined ||
      minAssets !== undefined ||
      input.max_assets !== undefined ||
      input.holding_company_rssd !== undefined;
    const pageProvesExistence =
      certs !== undefined && !narrowed && input.offset === 0 && certs.length <= input.limit;

    const service = getFdicService();
    const budget = callBudget();
    const [page, existing] = await Promise.all([
      service.searchInstitutions(query, ctx, budget),
      certs && !pageProvesExistence ? service.existingCerts(certs, ctx, budget) : undefined,
    ]);

    const found = existing ?? new Set(page.rows.map((row) => row.cert));
    const missing = certs?.filter((cert) => !found.has(cert)) ?? [];
    const end = input.offset + page.rows.length;
    const hasMore = end < page.total;

    ctx.log.info('Institution search', { total: page.total, returned: page.rows.length, status });

    if (page.total === 0) {
      const fragments: string[] = [];
      if (input.name && CREDIT_UNION_PATTERN.test(input.name)) {
        fragments.push(
          'Credit unions are insured by the NCUA, not the FDIC, and are not in this data.',
        );
      }
      if (input.status === undefined && status === 'active') {
        fragments.push(
          'Only active institutions were searched; set status to any to include closed, merged, and failed institutions.',
        );
      }
      if (name)
        fragments.push('Every word of the name must match; drop a word or check the spelling.');
      if (input.city) {
        fragments.push(
          'City matching is exact as FDIC spells it (for example Seattle, St. Louis); drop city and filter by state to browse.',
        );
      }
      if (minAssets !== undefined || input.max_assets !== undefined) {
        fragments.push('Asset bounds are in thousands of dollars (1000000 = $1 billion).');
      }
      ctx.enrich.notice(
        fragments.length ? fragments.join(' ') : 'No institutions matched these filters.',
      );
    } else if (page.rows.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the last of ${page.total} matches; lower offset or omit it.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: page.rows.length,
        cap: input.limit,
        guidance: `Showing matches ${input.offset + 1}–${end} of ${page.total}; pass offset ${end} for the next page, or narrow the filters.`,
      });
    }

    return {
      institutions: page.rows,
      status_filter: status,
      total: page.total,
      ...(hasMore ? { next_offset: end } : {}),
      ...(missing.length ? { missing_certs: missing } : {}),
      data_as_of: page.dataAsOf,
    };
  },

  format: (result) => {
    const lines = [
      `## ${num(result.total)} institutions match (status filter: ${result.status_filter})`,
      `Data as of ${result.data_as_of}. Dollar amounts are thousands of US dollars.`,
    ];
    if (result.next_offset !== undefined) lines.push(`Next page: offset ${result.next_offset}.`);
    if (result.missing_certs?.length) {
      lines.push(`No institution record for CERT ${result.missing_certs.join(', ')}.`);
    }
    for (const inst of result.institutions) {
      lines.push('', `### ${inline(inst.name)} — CERT ${inst.cert}`);
      const status = inst.active ? 'Active' : 'Inactive';
      const ended = inst.ended_on ? `, ended ${inst.ended_on}` : '';
      const successor =
        inst.successor_cert !== undefined ? `; successor CERT ${inst.successor_cert}` : '';
      lines.push(`- **Status:** ${status}${ended}${successor}`);
      // As FDIC records it: a Louisiana parish or an Alaska borough is no "County".
      const county = inst.county ? ` · county ${inline(inst.county)}` : '';
      lines.push(`- **Location:** ${inline(inst.city)}, ${inst.state}${county}`);
      const regulator = inst.regulator ? `; regulator ${inline(inst.regulator)}` : '';
      lines.push(
        `- **Charter class:** ${inst.bank_class.code} — ${inline(inst.bank_class.label)}${regulator}`,
      );
      if (inst.holding_company) {
        const rssd =
          inst.holding_company.rssd !== undefined ? ` (RSSD ${inst.holding_company.rssd})` : '';
        lines.push(`- **Holding company:** ${inline(inst.holding_company.name)}${rssd}`);
      }
      const dates = [
        inst.established_on ? `established ${inst.established_on}` : undefined,
        inst.insured_since ? `insured since ${inst.insured_since}` : undefined,
        inst.fed_rssd !== undefined ? `Fed RSSD ${inst.fed_rssd}` : undefined,
      ].filter(Boolean);
      if (dates.length) lines.push(`- ${dates.join('; ')}`);
      const financials = [
        inst.total_assets !== undefined ? `total assets ${num(inst.total_assets)}` : undefined,
        inst.total_deposits !== undefined
          ? `total deposits ${num(inst.total_deposits)}`
          : undefined,
        inst.domestic_offices !== undefined
          ? `domestic offices ${num(inst.domestic_offices)}`
          : undefined,
      ].filter(Boolean);
      if (financials.length || inst.last_report_date) {
        const asOf = inst.last_report_date ? ` (report ${inst.last_report_date})` : '';
        lines.push(`- **Latest report${asOf}:** ${financials.join('; ') || 'no figures on file'}`);
      }
      if (inst.matched_on) {
        const kind = inst.matched_on.field === 'former_name' ? 'former name' : 'trade name';
        lines.push(
          `- **Matched on ${kind}** (${inst.matched_on.field}): ${inline(inst.matched_on.text)}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
