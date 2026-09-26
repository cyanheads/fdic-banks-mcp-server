/**
 * @fileoverview Tests for the server config: FDIC_* defaults, bounds, the
 * stringbool flag, and validation errors that name the environment variable.
 * Each case loads a fresh module, since the parsed config is memoized.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

const VARS = [
  'FDIC_RATE_LIMIT_RPS',
  'FDIC_CACHE_TTL_SECONDS',
  'FDIC_PANEL_MAX_ROWS',
  'FDIC_DATASET_TTL_SECONDS',
  'FDIC_DATAFRAME_DROP_ENABLED',
] as const;

async function loadConfig(env: Partial<Record<(typeof VARS)[number], string>> = {}) {
  for (const name of VARS) vi.stubEnv(name, env[name] ?? '');
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('applies the documented defaults when every variable is unset or blank', async () => {
    const getServerConfig = await loadConfig();
    expect(getServerConfig()).toEqual({
      rateLimitRps: 8,
      cacheTtlSeconds: 3600,
      panelMaxRows: 50_000,
      datasetTtlSeconds: 86_400,
      dataframeDropEnabled: false,
    });
  });

  it('reads overrides, including a 0 cache TTL and a stringbool flag', async () => {
    const getServerConfig = await loadConfig({
      FDIC_RATE_LIMIT_RPS: '15',
      FDIC_CACHE_TTL_SECONDS: '0',
      FDIC_PANEL_MAX_ROWS: '1000',
      FDIC_DATASET_TTL_SECONDS: '60',
      FDIC_DATAFRAME_DROP_ENABLED: 'true',
    });
    expect(getServerConfig()).toEqual({
      rateLimitRps: 15,
      cacheTtlSeconds: 0,
      panelMaxRows: 1000,
      datasetTtlSeconds: 60,
      dataframeDropEnabled: true,
    });
  });

  it('reads FDIC_DATAFRAME_DROP_ENABLED=false as false, not as a truthy string', async () => {
    const getServerConfig = await loadConfig({ FDIC_DATAFRAME_DROP_ENABLED: 'false' });
    expect(getServerConfig().dataframeDropEnabled).toBe(false);
  });

  it.each([
    ['FDIC_RATE_LIMIT_RPS', '16'],
    ['FDIC_RATE_LIMIT_RPS', '0'],
    ['FDIC_PANEL_MAX_ROWS', '999'],
    ['FDIC_PANEL_MAX_ROWS', '200001'],
    ['FDIC_DATASET_TTL_SECONDS', '59'],
    ['FDIC_CACHE_TTL_SECONDS', '-1'],
    ['FDIC_DATAFRAME_DROP_ENABLED', 'maybe'],
  ] as const)('rejects %s=%s with an error naming the variable', async (name, value) => {
    const getServerConfig = await loadConfig({ [name]: value });
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining(name),
      }),
    );
  });
});
