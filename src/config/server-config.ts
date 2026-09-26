/**
 * @fileoverview Server-specific configuration: FDIC request pacing, the response
 * cache, panel size, and staged-dataframe lifetime.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  rateLimitRps: z.coerce
    .number()
    .int()
    .min(1)
    .max(15)
    .default(8)
    .describe(
      'Maximum request starts per second to api.fdic.gov, shared by every caller of this process.',
    ),
  cacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(3600)
    .describe('TTL of the in-process response cache in seconds; 0 disables caching.'),
  panelMaxRows: z.coerce
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .default(50_000)
    .describe(
      'Row cap for one fdic_query_financials panel. Newest quarters are kept when it binds.',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(86_400)
    .describe('Per-table TTL for staged dataframes, in seconds.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Set to "true" to register fdic_dataframe_drop live; otherwise it is registered disabled with the enable hint.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parsed server config; env var names appear in validation errors. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    rateLimitRps: 'FDIC_RATE_LIMIT_RPS',
    cacheTtlSeconds: 'FDIC_CACHE_TTL_SECONDS',
    panelMaxRows: 'FDIC_PANEL_MAX_ROWS',
    datasetTtlSeconds: 'FDIC_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'FDIC_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
