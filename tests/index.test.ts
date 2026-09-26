/**
 * @fileoverview Tests for the src/index.ts entry point: the ./.env pre-load that
 * must land before the CANVAS_PROVIDER_TYPE default and the drop gate are read
 * (Design Decision 36), run from a temporary working directory with createApp()
 * faked at the process boundary so no transport starts; the createApp() options;
 * the setup()/teardown() wiring of the FDIC service and the canvas bridge; and
 * the dataframe listing turned off only over HTTP with auth off.
 * @module tests/index.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreServices, CreateAppOptions } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasDouble } from './helpers/canvas.js';

const createApp = vi.hoisted(() => vi.fn(async (_options: unknown) => ({})));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp,
}));

/** Every variable a test .env sets, cleared before and restored after each test. */
const ENV_KEYS = [
  'CANVAS_PROVIDER_TYPE',
  'FDIC_RATE_LIMIT_RPS',
  'FDIC_CACHE_TTL_SECONDS',
  'FDIC_PANEL_MAX_ROWS',
  'FDIC_DATASET_TTL_SECONDS',
  'FDIC_DATAFRAME_DROP_ENABLED',
] as const;

const originalCwd = process.cwd();
const savedEnv = new Map<string, string | undefined>();
let workdir: string;

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  workdir = await mkdtemp(join(tmpdir(), 'fdic-banks-entry-'));
  process.chdir(workdir);
  vi.resetModules();
  createApp.mockClear();
});

afterEach(async () => {
  process.chdir(originalCwd);
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  await rm(workdir, { recursive: true, force: true });
});

/** Imports the entry point fresh and returns the options it handed to createApp(). */
async function boot(): Promise<CreateAppOptions> {
  await import('@/index.js');
  expect(createApp).toHaveBeenCalledTimes(1);
  return createApp.mock.calls[0]?.[0] as CreateAppOptions;
}

async function dropTool() {
  return (await import('@/mcp-server/tools/definitions/dataframe-drop.tool.js')).dataframeDropTool;
}

describe('.env pre-load', () => {
  it('loads ./.env before the canvas default and the drop gate are read', async () => {
    await writeFile(
      join(workdir, '.env'),
      'CANVAS_PROVIDER_TYPE=none\nFDIC_DATAFRAME_DROP_ENABLED=true\nFDIC_PANEL_MAX_ROWS=1000\n',
    );
    const options = await boot();

    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
    expect(options.tools?.at(-1)).toBe(await dropTool());
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toMatchObject({ dataframeDropEnabled: true, panelMaxRows: 1000 });
  });

  it('defaults the canvas to duckdb and registers drop disabled when there is no .env', async () => {
    const options = await boot();
    const { disabledTool } = await import('@cyanheads/mcp-ts-core');

    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
    expect(options.tools?.at(-1)).toEqual(
      disabledTool(await dropTool(), {
        reason: expect.any(String),
        hint: 'FDIC_DATAFRAME_DROP_ENABLED=true',
      }),
    );
  });

  it('keeps variables already set in the environment over the .env values', async () => {
    process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
    process.env.FDIC_DATAFRAME_DROP_ENABLED = 'false';
    await writeFile(
      join(workdir, '.env'),
      'CANVAS_PROVIDER_TYPE=none\nFDIC_DATAFRAME_DROP_ENABLED=true\n',
    );
    const options = await boot();

    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
    expect(options.tools?.at(-1)).not.toBe(await dropTool());
  });

  it('surfaces a .env it cannot read instead of skipping it', async () => {
    await mkdir(join(workdir, '.env'));
    await expect(import('@/index.js')).rejects.toThrow();
    expect(createApp).not.toHaveBeenCalled();
  });
});

describe('createApp wiring', () => {
  it('hands createApp the server identity, a stateless session posture, and all ten tools', async () => {
    const options = await boot();
    expect(options).toMatchObject({
      name: 'fdic-banks-mcp-server',
      title: 'fdic-banks-mcp-server',
      sessionMode: 'stateless',
      resources: [],
      prompts: [],
      instructions: expect.stringContaining(
        'naming a staged df_<id> table — pass that name to fdic_dataframe_describe for its columns, then query it with fdic_dataframe_query.',
      ),
    });
    expect(options.tools?.map((t) => t.name)).toEqual([
      'fdic_search_institutions',
      'fdic_get_institution_financials',
      'fdic_compare_peers',
      'fdic_query_financials',
      'fdic_search_failures',
      'fdic_get_deposits',
      'fdic_list_reference',
      'fdic_dataframe_describe',
      'fdic_dataframe_query',
      'fdic_dataframe_drop',
    ]);
  });

  it('installs the FDIC service and the canvas bridge in setup(), and disposes the service in teardown()', async () => {
    const options = await boot();
    const { FdicService, getFdicService } = await import('@/services/fdic/fdic-service.js');
    const { CanvasBridge, getCanvasBridge } = await import(
      '@/services/canvas-bridge/canvas-bridge.js'
    );
    const stdio = { mcpTransportType: 'stdio', mcpAuthMode: 'none' };
    const withCanvas = { canvas: canvasDouble().canvas, config: stdio } as unknown as CoreServices;
    const withoutCanvas = { config: stdio } as unknown as CoreServices;

    expect(() => getFdicService()).toThrow();
    await options.setup?.(withCanvas);
    expect(getFdicService()).toBeInstanceOf(FdicService);
    expect(getCanvasBridge()).toBeInstanceOf(CanvasBridge);

    await options.setup?.(withoutCanvas);
    expect(getCanvasBridge()).toBeUndefined();

    await options.teardown?.(withoutCanvas);
    expect(() => getFdicService()).toThrow();
  });

  it.each([
    ['stdio', 'none', true],
    ['http', 'jwt', true],
    ['http', 'oauth', true],
    ['http', 'none', false],
  ] as const)(
    'over %s with auth %s, sets the dataframe listing to %s',
    async (transport, auth, listing) => {
      const options = await boot();
      const { getCanvasBridge } = await import('@/services/canvas-bridge/canvas-bridge.js');
      const core = {
        canvas: canvasDouble().canvas,
        config: { mcpTransportType: transport, mcpAuthMode: auth },
      } as unknown as CoreServices;
      await options.setup?.(core);
      expect(getCanvasBridge()?.listing).toBe(listing);
      await options.teardown?.(core);
    },
  );
});
