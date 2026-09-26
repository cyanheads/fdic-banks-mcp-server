/**
 * @fileoverview fdic_compare_peers — one institution against a peer group for one
 * quarter: peer median, quartiles, range, and the institution's percentile and rank
 * per metric, computed from per-institution values.
 * @module mcp-server/tools/definitions/compare-peers
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ASSET_BAND_CODES, assetBand, assetBandFor } from '@/services/fdic/asset-bands.js';
import { callBudget, getFdicService } from '@/services/fdic/fdic-service.js';
import {
  METRIC_BASES,
  METRIC_CATALOG,
  METRIC_UNITS,
  resolveMetrics,
} from '@/services/fdic/metric-catalog.js';
import { computePeerStats } from '@/services/fdic/peer-stats.js';
import { reportDateToIso } from '@/services/fdic/query-builder.js';
import { normalizeState } from '@/services/fdic/us-states.js';
import { blankAsUnset, metricEnum, reportDateInput, stateInput } from '../input-schemas.js';
import { cell, inline, metricValue, num } from '../markdown.js';

const BAND_INPUTS = ['same', 'any', ...ASSET_BAND_CODES] as const;
const RESOLVED_BANDS = ['any', ...ASSET_BAND_CODES] as const;

const stat = (description: string) => z.number().nullable().describe(description);

export const comparePeersTool = tool('fdic_compare_peers', {
  title: 'Compare an institution with its peers',
  description:
    "Compare one institution with a peer group for one quarter: for each metric, the institution's value next to the peer median, quartiles, minimum and maximum, and its percentile and rank. The default peer group is every institution in the same asset-size band that reported that quarter; narrow it to one state, widen it to all sizes, or name the peers by CERT. Dollar amounts are in thousands; ratios are percentages.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    cert: z
      .number()
      .int()
      .min(1)
      .describe(
        'FDIC certificate number of the institution to compare, from fdic_search_institutions.',
      ),
    report_date: reportDateInput(
      'Quarter to compare: a quarter-end date (2026-06-30), the same without dashes (20260630), or a quarter label (2026Q2). Omit for the latest quarter FDIC has published.',
    ),
    metrics: z
      .array(metricEnum)
      .max(20)
      .optional()
      .describe(
        'Up to 20 metric names (fdic_list_reference topic metrics). Omit for the default health set.',
      ),
    peer_asset_band: blankAsUnset(z.enum(BAND_INPUTS).optional()).describe(
      "Peer size band by total assets: same (the band holding the institution's own assets, default), any (all sizes), under_100m, 100m_1b, 1b_10b, 10b_250b, or over_250b; fdic_list_reference topic peer_asset_bands gives each band's bounds. Not combinable with peer_certs.",
    ),
    peer_state: stateInput(
      "Limit peers to one headquarters state: a two-letter code, a full state name, or same for the institution's own state. Omit for nationwide. Not combinable with peer_certs.",
    ),
    peer_certs: z
      .array(z.number().int().min(1).describe('FDIC certificate number of one peer.'))
      .max(200)
      .optional()
      .describe(
        'An explicit peer list of up to 200 CERTs, in place of the band and state peer group — pass it without peer_asset_band and peer_state. Fewer than five peers still computes, with a notice.',
      ),
  }),

  output: z.object({
    institution: z
      .object({
        cert: z.number().int().describe('FDIC certificate number.'),
        name: z.string().describe('Name as filed on the Call Report for the quarter.'),
        state: z.string().describe('Headquarters state postal code.'),
        total_assets: z
          .number()
          .optional()
          .describe(
            'Total assets for the quarter, USD thousands; absent when the filing carries none.',
          ),
        asset_band: z
          .enum(ASSET_BAND_CODES)
          .optional()
          .describe(
            "The size band the institution's total assets fall in; absent when the filing carries no total assets.",
          ),
      })
      .describe('The institution being compared.'),
    report_date: z.string().describe('Quarter-end date compared (YYYY-MM-DD).'),
    report_date_defaulted: z
      .boolean()
      .describe('True when report_date was omitted and the latest published quarter was used.'),
    peer_group: z
      .object({
        asset_band: z
          .enum(RESOLVED_BANDS)
          .describe(
            'Size band applied to peers; any when no size filter applied (including explicit peer_certs).',
          ),
        state: z
          .string()
          .optional()
          .describe(
            'Headquarters state peers were limited to; absent for a nationwide group or explicit peer_certs.',
          ),
        explicit_certs: z.boolean().describe('True when peers came from peer_certs.'),
        peer_count: z
          .number()
          .int()
          .describe(
            'Peers that filed a Call Report for the quarter, excluding the institution itself.',
          ),
        definition: z.string().describe('The peer group in one sentence.'),
      })
      .describe('How the peer group was built.'),
    comparisons: z
      .array(
        z
          .object({
            metric: z.string().describe('Catalog metric name.'),
            field: z
              .string()
              .describe('FDIC Call Report field code the metric maps to, e.g. ROAQ.'),
            unit: z.enum(METRIC_UNITS).describe('usd_thousands, percent (1.71 = 1.71%), or count.'),
            basis: z
              .enum(METRIC_BASES)
              .describe(
                'point_in_time = balance at quarter end; quarter = that quarter alone; quarter_annualized = ratio from the quarter, annualized; year_to_date = accumulated since January 1; ytd_annualized = ratio from the year-to-date flow, annualized.',
              ),
            value: stat(
              "The institution's value, in the metric's unit; null when it did not report the metric.",
            ),
            peer_count_with_value: z
              .number()
              .int()
              .describe('Peers that reported the metric — the statistics cover only these.'),
            peer_median: stat(
              "Median over the peers that reported the metric, in the metric's unit; null when none did.",
            ),
            peer_p25: stat(
              'Peer 25th percentile (linear interpolation between peer values); null when no peer reported the metric.',
            ),
            peer_p75: stat(
              'Peer 75th percentile (linear interpolation between peer values); null when no peer reported the metric.',
            ),
            peer_min: stat('Lowest peer value; null when no peer reported the metric.'),
            peer_max: stat('Highest peer value; null when no peer reported the metric.'),
            percentile: stat(
              "0–100: the institution's percentile among peers, 100 × (peers below + half of peers tied) / peers with a value; null when the institution or every peer did not report the metric.",
            ),
            rank: z
              .number()
              .int()
              .nullable()
              .describe(
                'Rank among the institution plus its peers with a value; 1 = highest value, ties share a rank. Whether high is good depends on the metric. Null when the institution did not report the metric.',
              ),
            rank_of: z
              .number()
              .int()
              .nullable()
              .describe(
                'Size of the ranking: peers with a value plus the institution; null when the institution did not report the metric.',
              ),
          })
          .describe('One metric compared.'),
      )
      .describe('Per-metric comparison, in metric order.'),
    peer_certs_missing: z
      .array(z.number().int().describe('A peer CERT with no report for the quarter.'))
      .optional()
      .describe('Explicit peer CERTs that filed no Call Report for the quarter.'),
    data_as_of: z.string().describe('When FDIC last rebuilt the financials index (ISO timestamp).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the peer group is empty or a metric has fewer than five peer values.',
      ),
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
      reason: 'no_report_for_period',
      code: JsonRpcErrorCode.NotFound,
      when: 'The institution filed no Call Report for report_date (inactive, not yet chartered, or not yet published)',
      recovery:
        'Call fdic_get_institution_financials for this CERT to see its reported quarters, then pass one of those as report_date.',
      severity: 'notice',
    },
    {
      reason: 'report_date_not_available',
      code: JsonRpcErrorCode.NotFound,
      when: 'report_date is after the latest published quarter',
      recovery:
        'Omit report_date to use the latest published quarter, or pass an earlier quarter-end date.',
      severity: 'notice',
    },
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'peer_state is not a state, DC, territory, or same',
      recovery:
        "Pass a two-letter postal code such as WA, a full state name, or same for the institution's own state.",
      severity: 'notice',
    },
    {
      reason: 'conflicting_peer_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'peer_certs is combined with peer_asset_band or peer_state',
      recovery:
        'Pass peer_certs alone for a named peer list, or drop peer_certs and define the group with peer_asset_band and peer_state.',
      severity: 'notice',
    },
    {
      reason: 'own_filing_incomplete',
      code: JsonRpcErrorCode.NotFound,
      when: "peer_asset_band or peer_state is same (the band's default), and the institution's Call Report for report_date carries no total assets or state to resolve it from",
      recovery:
        'Name the peer band (or any) in peer_asset_band and a state code in peer_state instead of same, or pass peer_certs.',
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
    const explicitCerts = input.peer_certs?.length ? [...new Set(input.peer_certs)] : undefined;
    if (explicitCerts && (input.peer_asset_band !== undefined || input.peer_state !== undefined)) {
      const named = [
        input.peer_asset_band !== undefined ? 'peer_asset_band' : undefined,
        input.peer_state !== undefined ? 'peer_state' : undefined,
      ].filter(Boolean);
      throw ctx.fail(
        'conflicting_peer_filters',
        `peer_certs cannot be combined with ${named.join(' and ')}.`,
        { ...ctx.recoveryFor('conflicting_peer_filters') },
      );
    }
    // Defaulted here, not in the schema, so an explicit band beside peer_certs is caught above.
    const peerAssetBand = input.peer_asset_band ?? 'same';
    const peerStateIsSame = input.peer_state?.toLowerCase() === 'same';
    const peerStateCode =
      input.peer_state === undefined || peerStateIsSame
        ? undefined
        : normalizeState(input.peer_state);
    if (input.peer_state !== undefined && !peerStateIsSame && !peerStateCode) {
      throw ctx.fail(
        'invalid_state',
        `peer_state "${input.peer_state}" is not a US state, DC, territory, or same.`,
        { ...ctx.recoveryFor('invalid_state') },
      );
    }
    const metrics = resolveMetrics(input.metrics);

    const service = getFdicService();
    const budget = callBudget();
    const defaulted = input.report_date === undefined;
    const reportDate =
      input.report_date === undefined
        ? (await service.latestReportDate(ctx, budget)).reportDate
        : reportDateToIso(input.report_date);

    const { row: own, dataAsOf } = await service.getQuarterRow(
      input.cert,
      reportDate,
      metrics,
      ctx,
      budget,
    );
    if (!own) {
      // Settled, not Promise.all: the latest-quarter lookup only refines which
      // miss this is, so its failure never hides cert_not_found.
      const [profileResult, latestResult] = await Promise.allSettled([
        service.getInstitution(input.cert, ctx, budget),
        defaulted ? undefined : service.latestReportDate(ctx, budget),
      ]);
      if (profileResult.status === 'rejected') throw profileResult.reason;
      const profile = profileResult.value;
      if (!profile.institution) {
        throw ctx.fail('cert_not_found', `No FDIC institution record carries CERT ${input.cert}.`, {
          ...ctx.recoveryFor('cert_not_found'),
        });
      }
      if (latestResult.status === 'rejected') {
        if (ctx.signal.aborted) throw latestResult.reason;
        ctx.log.warning('Latest quarter lookup failed; classifying the miss without it', {
          error:
            latestResult.reason instanceof Error
              ? latestResult.reason.message
              : String(latestResult.reason),
        });
      }
      const latest = latestResult.status === 'fulfilled' ? latestResult.value : undefined;
      if (latest && reportDate > latest.reportDate) {
        throw ctx.fail(
          'report_date_not_available',
          `FDIC has not published ${reportDate}; the latest published quarter is ${latest.reportDate}.`,
          {
            recovery: {
              hint: `Omit report_date to use the latest published quarter (${latest.reportDate}), or pass an earlier quarter-end date.`,
            },
          },
        );
      }
      const last = profile.institution.last_report_date;
      throw ctx.fail(
        'no_report_for_period',
        `CERT ${input.cert} filed no Call Report for ${reportDate}${last ? `; its last report is ${last}` : ''}.`,
        {
          recovery: {
            hint: last
              ? `Pass report_date ${last} (its last report), or call fdic_get_institution_financials for CERT ${input.cert} to see its reported quarters.`
              : `Call fdic_get_institution_financials for CERT ${input.cert} to see its reported quarters, then pass one of those as report_date.`,
          },
        },
      );
    }

    // A filing without total assets or a state still compares; only `same` needs them.
    const ownBand = own.totalAssets === null ? undefined : assetBandFor(own.totalAssets);
    let peerBand: (typeof RESOLVED_BANDS)[number];
    if (explicitCerts) peerBand = 'any';
    else if (peerAssetBand !== 'same') peerBand = peerAssetBand;
    else if (ownBand) peerBand = ownBand.code;
    else {
      throw ctx.fail(
        'own_filing_incomplete',
        `FDIC's ${reportDate} Call Report for CERT ${input.cert} carries no total assets, so peer_asset_band same has no band to resolve to.`,
        { ...ctx.recoveryFor('own_filing_incomplete') },
      );
    }
    let peerState = peerStateCode;
    if (peerStateIsSame) {
      peerState = normalizeState(own.state);
      if (!peerState) {
        throw ctx.fail(
          'own_filing_incomplete',
          `FDIC's ${reportDate} Call Report for CERT ${input.cert} carries no headquarters state, so peer_state same has no state to resolve to.`,
          { ...ctx.recoveryFor('own_filing_incomplete') },
        );
      }
    }
    const band = peerBand === 'any' ? undefined : assetBand(peerBand);

    const peers = await service.getPeerRows(
      {
        reportDate,
        metrics,
        ...(explicitCerts ? { certs: explicitCerts } : {}),
        ...(band?.min !== undefined ? { minAssets: band.min } : {}),
        ...(band?.max !== undefined ? { maxAssets: band.max } : {}),
        ...(peerState ? { state: peerState } : {}),
      },
      ctx,
      budget,
    );
    const peerRows = peers.rows.filter((row) => row.cert !== input.cert);
    const reported = new Set(peerRows.map((row) => row.cert));
    const peerCertsMissing = explicitCerts?.filter(
      (cert) => cert !== input.cert && !reported.has(cert),
    );

    const comparisons = metrics.map((metric) => {
      const { field, unit, basis } = METRIC_CATALOG[metric];
      const value = own.values[metric] ?? null;
      const peerValues = peerRows
        .map((row) => row.values[metric])
        .filter((v): v is number => v !== null && v !== undefined);
      return { metric, field, unit, basis, value, ...computePeerStats(value, peerValues) };
    });

    const definition = explicitCerts
      ? `The ${peerRows.length} institutions named in peer_certs that filed a Call Report for ${reportDate}; peer_asset_band and peer_state do not apply.`
      : `Institutions ${band ? `with total assets of ${band.phrase}` : 'of any size'} that filed a Call Report for ${reportDate}, ${peerState ? `headquartered in ${peerState}` : 'nationwide'}, excluding CERT ${input.cert} itself.`;

    if (peerRows.length === 0) {
      ctx.enrich.notice(
        explicitCerts
          ? `None of the peer_certs filed a Call Report for ${reportDate}; check them with fdic_search_institutions.`
          : 'No institutions matched the peer group; set peer_asset_band to any or drop peer_state.',
      );
    } else {
      const thin = comparisons.filter((c) => c.peer_count_with_value < 5).map((c) => c.metric);
      if (thin.length) {
        ctx.enrich.notice(
          `Fewer than five peers reported ${thin.join(', ')}; ${thin.length === 1 ? 'its quartiles are' : 'their quartiles are'} not meaningful.`,
        );
      }
    }

    ctx.log.info('Peer comparison', {
      cert: input.cert,
      reportDate,
      peers: peerRows.length,
      band: peerBand,
    });

    return {
      institution: {
        cert: input.cert,
        name: own.name,
        state: own.state,
        ...(own.totalAssets !== null ? { total_assets: own.totalAssets } : {}),
        ...(ownBand ? { asset_band: ownBand.code } : {}),
      },
      report_date: reportDate,
      report_date_defaulted: defaulted,
      peer_group: {
        asset_band: peerBand,
        ...(peerState ? { state: peerState } : {}),
        explicit_certs: explicitCerts !== undefined,
        peer_count: peerRows.length,
        definition,
      },
      comparisons,
      ...(peerCertsMissing?.length ? { peer_certs_missing: peerCertsMissing } : {}),
      data_as_of: dataAsOf,
    };
  },

  format: (result) => {
    const inst = result.institution;
    const pg = result.peer_group;
    const size =
      inst.total_assets === undefined
        ? 'total assets not reported for the quarter'
        : `total assets ${num(inst.total_assets)} (USD thousands) · size band ${inst.asset_band}`;
    const lines = [
      `## ${inline(inst.name)} (CERT ${inst.cert}) vs. peers — ${result.report_date}`,
      `${inst.state} · ${size}`,
      `Report date ${result.report_date}${result.report_date_defaulted ? ' (latest published quarter; report_date defaulted)' : ''}. Data as of ${result.data_as_of}.`,
      `**Peer group:** ${inline(pg.definition)}`,
      `${num(pg.peer_count)} peers · band ${pg.asset_band}${pg.state ? ` · state ${pg.state}` : ''} · explicit peer_certs: ${pg.explicit_certs ? 'yes' : 'no'}`,
    ];
    if (result.peer_certs_missing?.length) {
      lines.push(
        `Peer CERTs without a report for the quarter: ${result.peer_certs_missing.join(', ')}.`,
      );
    }
    lines.push(
      '',
      '| Metric | Field | Unit | Basis | Value | Median | P25 | P75 | Min | Max | Percentile | Rank | Peers with value |',
      '|:--|:--|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
    );
    for (const c of result.comparisons) {
      const fmt = (v: number | null) => metricValue(v, c.unit);
      const rank = c.rank === null ? '—' : `${c.rank} of ${num(c.rank_of)}`;
      lines.push(
        `| ${cell(c.metric)} | ${cell(c.field)} | ${c.unit} | ${c.basis} | ${fmt(c.value)} | ${fmt(c.peer_median)} | ${fmt(c.peer_p25)} | ${fmt(c.peer_p75)} | ${fmt(c.peer_min)} | ${fmt(c.peer_max)} | ${num(c.percentile, 1)} | ${rank} | ${num(c.peer_count_with_value)} |`,
      );
    }
    lines.push(
      '',
      'usd_thousands values are thousands of US dollars. Rank 1 is the highest value; whether high is good depends on the metric. — means not reported.',
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
