/**
 * @fileoverview fdic_list_reference — decode this server's vocabulary from the same
 * static tables the data tools read: metric catalog, bank classes, failure methods,
 * insurance funds, peer asset bands, and dataset coverage.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { ASSET_BANDS } from '@/services/fdic/asset-bands.js';
import { BANK_CLASS_CODES, BANK_CLASSES } from '@/services/fdic/bank-classes.js';
import { COVERAGE } from '@/services/fdic/coverage.js';
import { FAILURE_METHOD_CODES, FAILURE_METHODS } from '@/services/fdic/failure-methods.js';
import { INSURANCE_FUNDS } from '@/services/fdic/insurance-funds.js';
import {
  isDefaultMetric,
  METRIC_BASES,
  METRIC_CATALOG,
  METRIC_NAMES,
  METRIC_UNITS,
} from '@/services/fdic/metric-catalog.js';
import { inline, num } from '../markdown.js';

const TOPICS = [
  'metrics',
  'bank_classes',
  'failure_methods',
  'insurance_funds',
  'peer_asset_bands',
  'coverage',
] as const;

type Topic = (typeof TOPICS)[number];

const EntrySchema = z
  .object({
    code: z
      .string()
      .describe(
        'The value to pass or read back: metric name, class code, method code, fund, band, or dataset.',
      ),
    label: z.string().describe('What the code means.'),
    field: z
      .string()
      .optional()
      .describe('FDIC Call Report field code the metric maps to, e.g. ROAQ (metrics).'),
    unit: z
      .enum(METRIC_UNITS)
      .optional()
      .describe('Unit of the metric: usd_thousands, percent (1.71 = 1.71%), or count (metrics).'),
    basis: z
      .enum(METRIC_BASES)
      .optional()
      .describe(
        'point_in_time = balance at quarter end; quarter = that quarter alone; quarter_annualized = ratio from the quarter, annualized; year_to_date = accumulated since January 1; ytd_annualized = ratio from the year-to-date flow, annualized (metrics).',
      ),
    note: z
      .string()
      .optional()
      .describe('Caveat on the metric, such as zero meaning not reported.'),
    in_default_set: z
      .boolean()
      .optional()
      .describe('True when the metric is returned when a tool is called without metrics.'),
    resolution: z
      .enum(['FAILURE', 'ASSISTANCE'])
      .optional()
      .describe(
        'The one resolution type this method code occurs on; absent when it occurs on both (failure_methods).',
      ),
    min_assets: z
      .number()
      .optional()
      .describe('Inclusive lower bound of the band, total assets in thousands of US dollars.'),
    max_assets: z
      .number()
      .optional()
      .describe('Exclusive upper bound of the band, total assets in thousands of US dollars.'),
    starts: z.string().optional().describe('First period the dataset covers (coverage).'),
    cadence: z.string().optional().describe('How often the dataset reports (coverage).'),
    lag: z.string().optional().describe('Typical delay before a period appears (coverage).'),
  })
  .describe('One vocabulary entry; fields beyond code and label depend on the topic.');

type Entry = z.infer<typeof EntrySchema>;

function entriesFor(topic: Topic): Entry[] {
  switch (topic) {
    case 'metrics':
      return METRIC_NAMES.map((metric) => {
        const { field, unit, basis, label, note } = METRIC_CATALOG[metric];
        return {
          code: metric,
          label,
          field,
          unit,
          basis,
          ...(note ? { note } : {}),
          in_default_set: isDefaultMetric(metric),
        };
      });
    case 'bank_classes':
      return BANK_CLASS_CODES.map((code) => ({ code, label: BANK_CLASSES[code] }));
    case 'failure_methods':
      return FAILURE_METHOD_CODES.map((code) => {
        const { label, resolution } = FAILURE_METHODS[code];
        return { code, label, ...(resolution ? { resolution } : {}) };
      });
    case 'insurance_funds':
      return Object.entries(INSURANCE_FUNDS).map(([code, label]) => ({ code, label }));
    case 'peer_asset_bands':
      return [
        {
          code: 'same',
          label: "The band holding the institution's own total assets that quarter (the default)",
        },
        { code: 'any', label: 'Every institution that filed that quarter, whatever its size' },
        ...ASSET_BANDS.map(({ code, label, min, max }) => ({
          code,
          label,
          ...(min !== undefined ? { min_assets: min } : {}),
          ...(max !== undefined ? { max_assets: max } : {}),
        })),
      ];
    case 'coverage':
      return COVERAGE.map(({ code, label, starts, cadence, lag }) => ({
        code,
        label,
        starts,
        cadence,
        ...(lag ? { lag } : {}),
      }));
  }
}

export const listReferenceTool = tool('fdic_list_reference', {
  title: 'List FDIC reference vocabulary',
  description:
    'List the vocabulary the other fdic_ tools accept and return: every financial metric name with its FDIC field, unit, and basis (single quarter, year-to-date, or point in time), bank charter classes, failure resolution methods, insurance funds, the asset bands fdic_compare_peers uses, and the years each dataset covers. Served from built-in tables; no request to FDIC.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Which table to list: metrics (names, FDIC fields, units, basis, default set), bank_classes, failure_methods, insurance_funds, peer_asset_bands, or coverage (years and cadence of each dataset).',
      ),
  }),

  output: z.object({
    topic: z.enum(TOPICS).describe('The topic listed.'),
    entries: z.array(EntrySchema).describe('Every entry of the topic, in table order.'),
  }),

  handler(input) {
    return { topic: input.topic, entries: entriesFor(input.topic) };
  },

  format: (result) => {
    const lines = [`## FDIC reference — ${result.topic} (${result.entries.length} entries)`, ''];
    for (const e of result.entries) {
      const details: string[] = [];
      if (e.field) details.push(`field ${e.field}`);
      if (e.unit) details.push(`unit ${e.unit}`);
      if (e.basis) details.push(`basis ${e.basis}`);
      if (e.in_default_set !== undefined)
        details.push(`in default set: ${e.in_default_set ? 'yes' : 'no'}`);
      if (e.resolution) details.push(`occurs on ${e.resolution} only`);
      if (e.min_assets !== undefined) details.push(`min_assets ≥ ${num(e.min_assets)}`);
      if (e.max_assets !== undefined) details.push(`max_assets < ${num(e.max_assets)}`);
      if (e.starts) details.push(`starts ${e.starts}`);
      if (e.cadence) details.push(`cadence: ${e.cadence}`);
      if (e.lag) details.push(`lag: ${e.lag}`);
      if (e.note) details.push(`note: ${inline(e.note)}`);
      const suffix = details.length ? ` — ${details.join(' · ')}` : '';
      lines.push(`- **${e.code}** — ${inline(e.label)}${suffix}`);
    }
    if (result.topic === 'peer_asset_bands') {
      lines.push('', 'Band bounds are total assets in thousands of US dollars.');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
