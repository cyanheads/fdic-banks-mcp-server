/**
 * @fileoverview Read selection partitions and their caller-visible execution metadata.
 * @module mcp-server/tools/read-bounds
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Metadata mirrored by framework enrichment onto both response surfaces. */
export const certSelectionFields = {
  processed_certs: z
    .array(z.number().int().describe('Processed CERT.'))
    .optional()
    .describe('Deduplicated CERT selection actually queried; missing CERTs are a subset of these.'),
  deferred_certs: z
    .array(z.number().int().describe('Deferred CERT.'))
    .optional()
    .describe('CERTs not queried; pass these as certs (peer_certs for comparisons) in a new call.'),
  selection_notice: z
    .string()
    .optional()
    .describe('Execution caps and how to retrieve deferred selections.'),
};

/** Metric projection metadata; empty metrics resolve to the default set before partitioning. */
export const metricSelectionFields = {
  processed_metrics: z
    .array(z.string().describe('Processed metric.'))
    .optional()
    .describe('Metrics actually queried, including automatic panel sort/filter metrics.'),
  deferred_metrics: z
    .array(z.string().describe('Deferred metric.'))
    .optional()
    .describe('Metrics not queried; pass these as metrics in a new call.'),
  selection_notice: z
    .string()
    .optional()
    .describe('Execution caps and how to retrieve deferred selections.'),
};

/** Human-readable lists for the content trailer. */
export const certSelectionTrailer = {
  processed_certs: {
    render: (values: number[]) => `Processed CERTs: ${values.join(', ') || 'none'}.`,
  },
  deferred_certs: {
    render: (values: number[]) =>
      values.length
        ? `Deferred CERTs (not queried): ${values.join(', ')}. Pass these as certs, or peer_certs for comparisons, in a new call.`
        : 'Deferred CERTs: none.',
  },
};

/** Metric projection rendering for content-only clients. */
export const metricSelectionTrailer = {
  processed_metrics: {
    render: (values: string[]) => `Processed metrics: ${values.join(', ') || 'none'}.`,
  },
  deferred_metrics: {
    render: (values: string[]) =>
      values.length
        ? `Deferred metrics (not queried): ${values.join(', ')}. Pass these as metrics in a new call.`
        : 'Deferred metrics: none.',
  },
};

/** Deduplicates in request order before applying an execution cap. */
export function partitionSelection<T>(values: readonly T[], cap: number) {
  const unique = [...new Set(values)];
  return { processed: unique.slice(0, cap), deferred: unique.slice(cap) };
}
