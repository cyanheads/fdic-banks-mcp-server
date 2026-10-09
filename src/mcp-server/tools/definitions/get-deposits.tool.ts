/**
 * @fileoverview fdic_get_deposits — Summary of Deposits (annual, as of June 30):
 * an institution's branches and per-state market share, a geography's deposit
 * market ranked by institution with HHI, or one institution's position within one
 * market. Rankings come from every aggregation bucket and are computed locally;
 * a branch list or ranking larger than the preview is staged as a dataframe.
 * @module mcp-server/tools/definitions/get-deposits
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type ColumnUnit,
  getCanvasBridge,
  type StagedDataset,
  stagedNotice,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { callBudget, getFdicService } from '@/services/fdic/fdic-service.js';
import type { BranchRecord, SodBucket, SodGeography } from '@/services/fdic/types.js';
import { normalizeState } from '@/services/fdic/us-states.js';
import { blankAsUnset, stateInput } from '../input-schemas.js';
import { cell, inline, num } from '../markdown.js';

const MODES = ['institution', 'market', 'institution_in_market'] as const;

/** Deposits staged from the survey are balances as of June 30. */
const DEPOSIT_UNIT: ColumnUnit = { unit: 'usd_thousands', basis: 'point_in_time' };

/** Percentage share; `null` when the market holds no deposits. */
function sharePct(deposits: number, marketDeposits: number): number | null {
  return marketDeposits > 0 ? (100 * deposits) / marketDeposits : null;
}

/** Institutions in a market ranked by deposits (ties by CERT), with shares. */
function rankMarket(buckets: Map<number, SodBucket>) {
  let deposits = 0;
  let branchCount = 0;
  for (const bucket of buckets.values()) {
    deposits += bucket.deposits;
    branchCount += bucket.branchCount;
  }
  const ranking = [...buckets]
    .map(([cert, bucket]) => ({
      cert,
      deposits: bucket.deposits,
      branch_count: bucket.branchCount,
    }))
    .sort((a, b) => b.deposits - a.deposits || a.cert - b.cert)
    .map((row, index) => ({
      rank: index + 1,
      ...row,
      market_share_pct: sharePct(row.deposits, deposits),
    }));
  const hhi =
    deposits > 0
      ? ranking.reduce((sum, row) => sum + ((100 * row.deposits) / deposits) ** 2, 0)
      : null;
  return {
    ranking,
    market: { deposits, institution_count: ranking.length, branch_count: branchCount, hhi },
  };
}

const pct = (value: number | null) => (value === null ? '—' : `${num(value)}%`);

export const getDepositsTool = tool('fdic_get_deposits', {
  title: 'Get Summary of Deposits branches and market share',
  description:
    "Get Summary of Deposits data (branch-level domestic deposits, annual as of June 30, 1994 onward). With cert only: the institution's branches and its deposit market share in each state where it has offices. With a geography (state, county, city, ZIP, or MSA code): every institution in that market ranked by deposits, with market share and the Herfindahl-Hirschman index. With both: the institution's branches in that market and its rank and share there. Defaults to the latest survey year. Dollar amounts are in thousands.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    cert: blankAsUnset(z.number().int().min(1).optional()).describe(
      'FDIC certificate number, from fdic_search_institutions. Alone: its branches and per-state share. With a geography: its position in that market.',
    ),
    state: stateInput('Branch state: two-letter code in any case or full name.'),
    county: blankAsUnset(z.string().max(50).optional()).describe(
      'County as FDIC spells it (King, not King County — a trailing " County" is stripped), up to 50 characters; matched exactly as given or in title case, with a hyphen, apostrophe, or space between words also tried the other ways FDIC records it; requires state.',
    ),
    city: blankAsUnset(z.string().max(50).optional()).describe(
      'Branch city as FDIC spells it (Seattle, St. Louis), up to 50 characters; matched exactly as given or in title case, with a hyphen, apostrophe, or space between words also tried the other ways FDIC records it (Winston-Salem finds Winston Salem); requires state.',
    ),
    zip: blankAsUnset(
      z
        .string()
        .regex(/^\d{5}$/, 'Expected a five-digit ZIP code such as 02110')
        .optional(),
    ).describe('Five-digit branch ZIP code; leading zeros kept (02110).'),
    msa_code: blankAsUnset(
      z
        .string()
        .regex(
          /^[1-9]\d{4}$/,
          'Expected a five-digit metropolitan CBSA code (10180–49740, such as 42660); no code starts with 0',
        )
        .optional(),
    ).describe(
      'Five-digit CBSA (metropolitan area) code, 10180–49740; branch rows from a state-level call carry msa_code values to reuse. Non-metropolitan branches have no code.',
    ),
    year: blankAsUnset(z.number().int().min(1994).optional()).describe(
      'Survey year (deposits as of June 30), 1994 on. Omit for the latest survey.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(200).default(25)).describe(
      'Branches or ranked institutions returned inline (1–200). A larger set is also staged whole as a dataframe when this deployment stages dataframes.',
    ),
  }),

  output: z.object({
    mode: z
      .enum(MODES)
      .describe(
        'institution (cert only), market (geography only), or institution_in_market (both).',
      ),
    year: z.number().int().describe('Survey year (deposits as of June 30).'),
    year_defaulted: z
      .boolean()
      .describe('True when year was omitted and the latest survey was used.'),
    geography: z
      .object({
        state: z.string().optional().describe('Branch state postal code.'),
        county: z
          .string()
          .optional()
          .describe('County name as applied, with any trailing " County" removed.'),
        city: z.string().optional().describe('City name as given.'),
        zip: z.string().optional().describe('Five-digit ZIP code.'),
        msa_code: z.string().optional().describe('Five-digit CBSA code.'),
      })
      .optional()
      .describe('The geography as applied; absent in institution mode.'),
    institution: z
      .object({
        cert: z.number().int().describe('FDIC certificate number.'),
        name: z.string().describe('Institution name as filed for the survey year.'),
        deposits_in_scope: z
          .number()
          .describe(
            "Sum of its branch deposits in the queried scope, USD thousands (domestic, June 30) — not the Call Report's total_deposits.",
          ),
        branch_count: z.number().int().describe('Its branches in the queried scope.'),
      })
      .optional()
      .describe('The institution; present when it reported branches in scope.'),
    footprint: z
      .array(
        z
          .object({
            state: z.string().describe('State postal code.'),
            deposits: z.number().describe('Its branch deposits in the state, USD thousands.'),
            branch_count: z.number().int().describe('Its branches in the state.'),
            state_market_deposits: z
              .number()
              .describe('All branch deposits in the state, USD thousands.'),
            market_share_pct: z
              .number()
              .nullable()
              .describe('Its share of the state market, percent; null when the market holds none.'),
          })
          .describe('The institution in one state.'),
      )
      .optional()
      .describe('Institution mode: its deposits and share per state, largest first.'),
    market: z
      .object({
        deposits: z.number().describe('All branch deposits in the market, USD thousands.'),
        institution_count: z.number().int().describe('Institutions with branches in the market.'),
        branch_count: z.number().int().describe('Branches in the market.'),
        hhi: z
          .number()
          .nullable()
          .describe(
            'Herfindahl-Hirschman index over every institution: the sum of squared percentage shares (0–10,000); null when the market holds no deposits.',
          ),
      })
      .optional()
      .describe('Market modes: the whole market in the geography.'),
    position: z
      .object({
        rank: z.number().int().describe('Rank by deposits in the market; 1 = largest.'),
        of: z.number().int().describe('Institutions ranked.'),
        deposits: z.number().describe('Its deposits in the market, USD thousands.'),
        market_share_pct: z
          .number()
          .nullable()
          .describe('Its market share, percent; null when the market holds no deposits.'),
      })
      .optional()
      .describe('institution_in_market: present when the institution has branches in the market.'),
    institutions: z
      .array(
        z
          .object({
            rank: z.number().int().describe('Rank by deposits; 1 = largest.'),
            cert: z.number().int().describe('FDIC certificate number.'),
            name: z
              .string()
              .optional()
              .describe(
                'Current name, or the name at closing, from the institution record; absent when no record carries the CERT.',
              ),
            deposits: z.number().describe('Deposits in the market, USD thousands.'),
            branch_count: z.number().int().describe('Branches in the market.'),
            market_share_pct: z
              .number()
              .nullable()
              .describe('Market share, percent; null when the market holds no deposits.'),
          })
          .describe('One institution in the market.'),
      )
      .optional()
      .describe('Market mode: institutions ranked by deposits (preview).'),
    branches: z
      .array(
        z
          .object({
            branch_id: z
              .number()
              .int()
              .describe('FDIC unique branch number, stable across survey years.'),
            branch_number: z
              .number()
              .int()
              .describe("Institution's own branch number; 0 is the main office."),
            name: z.string().describe('Branch name.'),
            main_office: z.boolean().describe('True for the main office.'),
            address: z.string().describe('Street address.'),
            city: z.string().describe('City.'),
            county: z.string().describe('County name as FDIC records it, e.g. King.'),
            state: z.string().describe('State postal code.'),
            zip: z.string().describe('Five-digit ZIP code.'),
            msa_code: z
              .string()
              .optional()
              .describe(
                'Five-digit CBSA code, reusable as msa_code; absent for a non-metropolitan branch.',
              ),
            msa_name: z
              .string()
              .optional()
              .describe('Metropolitan area name; absent for a non-metropolitan branch.'),
            deposits: z
              .number()
              .describe(
                'Deposits booked at the branch, USD thousands (booking, not where customers live).',
              ),
            established_on: z.string().optional().describe('Date established (YYYY-MM-DD).'),
            latitude: z.number().optional().describe('Latitude, decimal degrees.'),
            longitude: z.number().optional().describe('Longitude, decimal degrees.'),
          })
          .describe('One branch; an optional field is absent when FDIC holds no value for it.'),
      )
      .optional()
      .describe('Institution modes: branches in scope, main office first (preview).'),
    total_rows: z
      .number()
      .int()
      .describe('Full count of the branches (institution modes) or ranked institutions (market).'),
    dataset: z
      .object({
        name: z.string().describe('Dataframe name for fdic_dataframe_query.'),
        row_count: z.number().int().describe('Rows staged.'),
        expires_at: z.string().describe('When the dataframe is dropped (ISO 8601).'),
      })
      .optional()
      .describe(
        'The staged full collection; present only when it exceeded the preview and this deployment staged it as a dataframe.',
      ),
    data_as_of: z
      .string()
      .describe('When FDIC last rebuilt the Summary of Deposits index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, or where the full collection is staged.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the preview holds fewer rows than total_rows.'),
    shown: z.number().optional().describe('Rows in the preview.'),
    cap: z.number().optional().describe('The limit applied to the preview.'),
  },

  errors: [
    {
      reason: 'no_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither cert nor any geography (state, county, city, zip, msa_code) given',
      recovery:
        "Pass cert for one institution's branches, a geography (state, county, city, zip, or msa_code) for a market view, or both.",
      severity: 'notice',
    },
    {
      reason: 'location_requires_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county or city given without state',
      recovery:
        'Add state as a two-letter code alongside county or city — the same names recur across states.',
      severity: 'notice',
    },
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'state is not a US state, DC, or territory code or name',
      recovery: 'Pass a two-letter postal code such as WA or a full state name such as Washington.',
      severity: 'notice',
    },
    {
      reason: 'year_not_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'year is after the latest survey in the index',
      recovery:
        'Omit year to use the latest Summary of Deposits, or pass an earlier year from 1994 on.',
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
    const geographyGiven =
      input.state !== undefined ||
      input.county !== undefined ||
      input.city !== undefined ||
      input.zip !== undefined ||
      input.msa_code !== undefined;
    if (input.cert === undefined && !geographyGiven) {
      throw ctx.fail('no_scope', 'Pass cert, a geography, or both.');
    }
    if ((input.county !== undefined || input.city !== undefined) && input.state === undefined) {
      throw ctx.fail('location_requires_state', 'county and city need state alongside them.');
    }
    const state = input.state === undefined ? undefined : normalizeState(input.state);
    if (input.state !== undefined && state === undefined) {
      throw ctx.fail('invalid_state', `"${input.state}" is not a US state, DC, or territory.`);
    }
    const county = input.county?.replace(/\s+county$/i, '');
    const geography: SodGeography | undefined = geographyGiven
      ? {
          ...(state ? { state } : {}),
          ...(county ? { county } : {}),
          ...(input.city ? { city: input.city } : {}),
          ...(input.zip ? { zip: input.zip } : {}),
          ...(input.msa_code ? { msaCode: Number(input.msa_code) } : {}),
        }
      : undefined;
    const mode: (typeof MODES)[number] =
      input.cert === undefined ? 'market' : geography ? 'institution_in_market' : 'institution';

    const service = getFdicService();
    const budget = callBudget();
    const latest = await service.latestSodYear(ctx, budget);
    if (input.year !== undefined && input.year > latest.year) {
      throw ctx.fail(
        'year_not_available',
        `The ${input.year} Summary of Deposits is not in the index; the latest survey is ${latest.year}.`,
        {
          recovery: {
            hint: `Omit year to use the latest Summary of Deposits (${latest.year}), or pass an earlier year from 1994 on.`,
          },
        },
      );
    }
    const year = input.year ?? latest.year;
    const bridge = getCanvasBridge();
    const queryParams: Record<string, unknown> = { ...input };

    /** Stages the branch list when it exceeds the preview. */
    const stageBranches = (cert: number, name: string, branches: readonly BranchRecord[]) =>
      bridge && branches.length > input.limit
        ? bridge.stage(ctx, {
            sourceTool: 'fdic_get_deposits',
            queryParams,
            rows: branches.map((b) => ({
              cert,
              institution_name: name,
              year,
              branch_id: b.branch_id,
              branch_number: b.branch_number,
              branch_name: b.name,
              main_office: b.main_office,
              address: b.address,
              city: b.city,
              county: b.county,
              state: b.state,
              zip: b.zip,
              msa_code: b.msa_code ?? null,
              msa_name: b.msa_name ?? null,
              deposits: b.deposits,
              established_on: b.established_on ?? null,
              latitude: b.latitude ?? null,
              longitude: b.longitude ?? null,
            })),
            schema: [
              { name: 'cert', type: 'INTEGER' },
              { name: 'institution_name', type: 'VARCHAR' },
              { name: 'year', type: 'INTEGER' },
              { name: 'branch_id', type: 'INTEGER' },
              { name: 'branch_number', type: 'INTEGER' },
              { name: 'branch_name', type: 'VARCHAR' },
              { name: 'main_office', type: 'BOOLEAN' },
              { name: 'address', type: 'VARCHAR' },
              { name: 'city', type: 'VARCHAR' },
              { name: 'county', type: 'VARCHAR' },
              { name: 'state', type: 'VARCHAR' },
              { name: 'zip', type: 'VARCHAR' },
              { name: 'msa_code', type: 'VARCHAR' },
              { name: 'msa_name', type: 'VARCHAR' },
              { name: 'deposits', type: 'DOUBLE' },
              { name: 'established_on', type: 'DATE' },
              { name: 'latitude', type: 'DOUBLE' },
              { name: 'longitude', type: 'DOUBLE' },
            ],
            columnUnits: { deposits: DEPOSIT_UNIT },
          })
        : Promise.resolve(undefined);

    let institution:
      | { branch_count: number; cert: number; deposits_in_scope: number; name: string }
      | undefined;
    let footprint:
      | Array<{
          branch_count: number;
          deposits: number;
          market_share_pct: number | null;
          state: string;
          state_market_deposits: number;
        }>
      | undefined;
    let market: ReturnType<typeof rankMarket>['market'] | undefined;
    let position:
      | { deposits: number; market_share_pct: number | null; of: number; rank: number }
      | undefined;
    let institutions:
      | Array<ReturnType<typeof rankMarket>['ranking'][number] & { name?: string }>
      | undefined;
    let branches: BranchRecord[] | undefined;
    let totalRows: number;
    let dataset: StagedDataset | undefined;
    let dataAsOf = latest.dataAsOf;

    if (input.cert !== undefined && mode === 'institution') {
      const cert = input.cert;
      const [found, stateMarkets] = await Promise.all([
        service.getBranches({ cert, year }, ctx, budget),
        service.sodStateMarkets(year, ctx, budget),
      ]);
      dataAsOf = found.dataAsOf;
      const byState = new Map<string, { branch_count: number; deposits: number }>();
      for (const branch of found.rows) {
        const entry = byState.get(branch.state) ?? { branch_count: 0, deposits: 0 };
        entry.branch_count++;
        entry.deposits += branch.deposits;
        byState.set(branch.state, entry);
      }
      footprint = [...byState]
        .map(([code, entry]) => {
          const stateMarketDeposits = stateMarkets.get(code)?.deposits ?? 0;
          return {
            state: code,
            deposits: entry.deposits,
            branch_count: entry.branch_count,
            state_market_deposits: stateMarketDeposits,
            market_share_pct: sharePct(entry.deposits, stateMarketDeposits),
          };
        })
        .sort((a, b) => b.deposits - a.deposits || a.state.localeCompare(b.state));
      const name = found.institutionName ?? '';
      if (found.rows.length) {
        institution = {
          cert,
          name,
          deposits_in_scope: footprint.reduce((sum, s) => sum + s.deposits, 0),
          branch_count: found.rows.length,
        };
      }
      branches = found.rows.slice(0, input.limit);
      totalRows = found.rows.length;
      dataset = await stageBranches(cert, name, found.rows);
    } else if (input.cert !== undefined && geography) {
      const cert = input.cert;
      const [found, marketBuckets] = await Promise.all([
        service.getBranches({ cert, geography, year }, ctx, budget),
        service.sodMarketByCert({ geography, year }, ctx, budget),
      ]);
      dataAsOf = found.dataAsOf;
      const ranked = rankMarket(marketBuckets.buckets);
      market = ranked.market;
      const own = ranked.ranking.find((row) => row.cert === cert);
      if (own) {
        position = {
          rank: own.rank,
          of: ranked.ranking.length,
          deposits: own.deposits,
          market_share_pct: own.market_share_pct,
        };
      }
      const name = found.institutionName ?? '';
      if (found.rows.length) {
        institution = {
          cert,
          name,
          deposits_in_scope: found.rows.reduce((sum, b) => sum + b.deposits, 0),
          branch_count: found.rows.length,
        };
      }
      branches = found.rows.slice(0, input.limit);
      totalRows = found.rows.length;
      dataset = await stageBranches(cert, name, found.rows);
    } else {
      const marketBuckets = await service.sodMarketByCert(
        { geography: geography ?? {}, year },
        ctx,
        budget,
      );
      dataAsOf = marketBuckets.dataAsOf;
      const ranked = rankMarket(marketBuckets.buckets);
      market = ranked.market;
      totalRows = ranked.ranking.length;
      const staging = bridge !== undefined && ranked.ranking.length > input.limit;
      const preview = ranked.ranking.slice(0, input.limit);
      const names = staging
        ? await service.institutionDirectory(ctx, budget)
        : await service.institutionNames(
            preview.map((row) => row.cert),
            ctx,
            budget,
          );
      institutions = preview.map((row) => {
        const name = names.get(row.cert);
        return name === undefined ? row : { ...row, name };
      });
      if (staging) {
        dataset = await bridge.stage(ctx, {
          sourceTool: 'fdic_get_deposits',
          queryParams,
          rows: ranked.ranking.map((row) => ({
            year,
            rank: row.rank,
            cert: row.cert,
            name: names.get(row.cert) ?? null,
            deposits: row.deposits,
            branch_count: row.branch_count,
            market_share_pct: row.market_share_pct,
          })),
          schema: [
            { name: 'year', type: 'INTEGER' },
            { name: 'rank', type: 'INTEGER' },
            { name: 'cert', type: 'INTEGER' },
            { name: 'name', type: 'VARCHAR' },
            { name: 'deposits', type: 'DOUBLE' },
            { name: 'branch_count', type: 'INTEGER' },
            { name: 'market_share_pct', type: 'DOUBLE' },
          ],
          columnUnits: {
            deposits: DEPOSIT_UNIT,
            branch_count: { unit: 'count', basis: 'point_in_time' },
            market_share_pct: { unit: 'percent', basis: 'point_in_time' },
          },
        });
      }
    }

    const shown = branches?.length ?? institutions?.length ?? 0;
    if (totalRows === 0) {
      const fragments: string[] = [];
      const marketEmpty = market === undefined || market.institution_count === 0;
      if (mode === 'institution') {
        fragments.push(
          `CERT ${input.cert} reported no branches in the ${year} survey — it may have closed or not yet opened; check its status and last report date with fdic_search_institutions and try an earlier year.`,
        );
      } else if (mode === 'institution_in_market' && !marketEmpty) {
        fragments.push(
          `CERT ${input.cert} has no branches in this market in the ${year} survey; pass cert alone to see the states where it has branches.`,
        );
      }
      if (marketEmpty && (county || input.city)) {
        fragments.push(
          "County and city names match exactly as FDIC spells them (for example King, St. Louis); drop the county or city and use state to browse the state's market.",
        );
      }
      if (marketEmpty && input.msa_code) {
        fragments.push(
          'msa_code is a 5-digit CBSA code; branch rows from a state-level call carry msa_code values to reuse.',
        );
      }
      if (input.year !== undefined) {
        fragments.push(`The Summary of Deposits runs from 1994 through ${latest.year}.`);
      }
      ctx.enrich.notice(
        fragments.length ? fragments.join(' ') : `No Summary of Deposits rows matched in ${year}.`,
      );
    } else if (totalRows > shown) {
      const what = institutions ? 'ranked institutions' : 'branches';
      ctx.enrich.truncated({
        shown,
        cap: input.limit,
        guidance: `Showing ${shown} of ${totalRows} ${what}. ${
          dataset
            ? stagedNotice(dataset)
            : 'Raise limit (max 200) or narrow the geography to see the rest inline.'
        }`,
      });
    }

    ctx.log.info('Summary of Deposits', { mode, year, totalRows, staged: dataset?.name });

    return {
      mode,
      year,
      year_defaulted: input.year === undefined,
      ...(geography
        ? {
            geography: {
              ...(state ? { state } : {}),
              ...(county ? { county } : {}),
              ...(input.city ? { city: input.city } : {}),
              ...(input.zip ? { zip: input.zip } : {}),
              ...(input.msa_code ? { msa_code: input.msa_code } : {}),
            },
          }
        : {}),
      ...(institution ? { institution } : {}),
      ...(footprint ? { footprint } : {}),
      ...(market ? { market } : {}),
      ...(position ? { position } : {}),
      ...(institutions ? { institutions } : {}),
      ...(branches ? { branches } : {}),
      total_rows: totalRows,
      ...(dataset ? { dataset } : {}),
      data_as_of: dataAsOf,
    };
  },

  format: (result) => {
    const lines = [
      `## Summary of Deposits ${result.year} — ${result.mode.replace(/_/g, ' ')} view (mode ${result.mode})`,
      `Survey year ${result.year}${result.year_defaulted ? ' (latest survey; year defaulted)' : ''}. Deposits are domestic branch deposits as of June 30, in thousands of US dollars. Data as of ${result.data_as_of}. Total rows: ${num(result.total_rows)}.`,
    ];
    const g = result.geography;
    if (g) {
      const parts = [
        g.state ? `state ${g.state}` : undefined,
        g.county ? `county ${inline(g.county)}` : undefined,
        g.city ? `city ${inline(g.city)}` : undefined,
        g.zip ? `ZIP ${g.zip}` : undefined,
        g.msa_code ? `MSA ${g.msa_code}` : undefined,
      ].filter(Boolean);
      lines.push(`**Geography:** ${parts.join(' · ')}`);
    }
    if (result.institution) {
      const i = result.institution;
      lines.push(
        `**Institution:** ${inline(i.name)} (CERT ${i.cert}) — deposits in scope ${num(i.deposits_in_scope)} across ${num(i.branch_count)} branches.`,
      );
    }
    if (result.position) {
      const p = result.position;
      lines.push(
        `**Position:** rank ${p.rank} of ${p.of} · deposits ${num(p.deposits)} · market share ${pct(p.market_share_pct)}`,
      );
    }
    if (result.market) {
      const m = result.market;
      lines.push(
        `**Market:** deposits ${num(m.deposits)} · ${num(m.institution_count)} institutions · ${num(m.branch_count)} branches · HHI ${m.hhi === null ? '— (no deposits)' : num(m.hhi, 0)}`,
      );
    }
    if (result.dataset) {
      lines.push(
        `**Staged:** ${result.dataset.name} — ${num(result.dataset.row_count)} rows, expires ${result.dataset.expires_at}. Query it with fdic_dataframe_query.`,
      );
    }

    if (result.footprint?.length) {
      lines.push(
        '',
        '| State | Deposits | Branches | State market deposits | Market share |',
        '|:--|--:|--:|--:|--:|',
      );
      for (const s of result.footprint) {
        lines.push(
          `| ${cell(s.state)} | ${num(s.deposits)} | ${num(s.branch_count)} | ${num(s.state_market_deposits)} | ${pct(s.market_share_pct)} |`,
        );
      }
    }

    if (result.institutions?.length) {
      lines.push(
        '',
        '| Rank | CERT | Name | Deposits | Branches | Market share |',
        '|--:|--:|:--|--:|--:|--:|',
      );
      for (const r of result.institutions) {
        lines.push(
          `| ${r.rank} | ${r.cert} | ${r.name === undefined ? '(no institution record)' : cell(r.name)} | ${num(r.deposits)} | ${num(r.branch_count)} | ${pct(r.market_share_pct)} |`,
        );
      }
    }

    if (result.branches?.length) {
      lines.push('', '**Branches** (branch number · name · ID):');
      for (const b of result.branches) {
        const msa = b.msa_code
          ? ` · MSA ${b.msa_code}${b.msa_name ? ` ${inline(b.msa_name)}` : ''}`
          : ' · non-metropolitan';
        // As FDIC records it: a Louisiana parish or an Alaska borough is no "County".
        const county = b.county ? ` · county ${inline(b.county)}` : '';
        const est = b.established_on ? ` · established ${b.established_on}` : '';
        const lat = b.latitude !== undefined ? ` · lat ${b.latitude}` : '';
        const lon = b.longitude !== undefined ? ` · lon ${b.longitude}` : '';
        lines.push(
          `- #${b.branch_number} ${inline(b.name)} (ID ${b.branch_id}, ${b.main_office ? 'main office' : 'branch office'}) — ${inline(b.address)}, ${inline(b.city)}, ${inline(b.state)} ${inline(b.zip)}${county}${msa} · deposits ${num(b.deposits)}${est}${lat}${lon}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
