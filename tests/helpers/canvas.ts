/**
 * @fileoverview The DataCanvas boundary for tests: a real in-memory DuckDB
 * `DataCanvas` with its sweeper off and an injectable canvas lifetime, a minimal
 * `DataCanvas` double that records `registerTable` calls and fails on demand,
 * and tenant sessions — per-call contexts that share one tenant's `ctx.state`,
 * as successive requests from one tenant do in production.
 * @module tests/helpers/canvas
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
  type RegisterRows,
  type RegisterTableOptions,
  type RegisterTableResult,
} from '@cyanheads/mcp-ts-core/canvas';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextOptions } from '@cyanheads/mcp-ts-core/testing';

/**
 * A real DuckDB-backed canvas. The registry's sweeper is off so no timer
 * outlives a test; `canvasTtlMs` sets the canvas-level sliding TTL (default
 * 7 days, so a table's own TTL expires first). Its clock reads `Date.now()` on
 * every call, so a test drives it with `vi.useFakeTimers({ toFake: ['Date'] })`.
 */
export function createDuckdbCanvas(options: { canvasTtlMs?: number } = {}): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10_000,
    exportRootPath: join(tmpdir(), 'fdic-banks-mcp-server-test-exports'),
    memoryLimitMb: 256,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(
    provider,
    {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      sweeperIntervalMs: 0,
      ttlMs: options.canvasTtlMs ?? 7 * 24 * 3_600_000,
      absoluteCapMs: 30 * 24 * 3_600_000,
    },
    // Read the global clock per call: a captured `Date.now` would ignore faked time.
    () => Date.now(),
  );
  return new DataCanvas(provider, registry);
}

/** One `registerTable` call the double received, its rows materialized. */
export interface Registration {
  name: string;
  options: RegisterTableOptions | undefined;
  rows: Record<string, unknown>[];
}

/**
 * A minimal `DataCanvas` double: `acquire()` hands out one instance whose
 * `registerTable` records the call and then runs `register` (by default a
 * success echoing the row count). Nothing else on the canvas is reachable.
 */
export function canvasDouble(
  register: (call: Registration) => Promise<RegisterTableResult> | RegisterTableResult = (
    call,
  ) => ({ tableName: call.name, rowCount: call.rows.length, columns: [] }),
) {
  const registrations: Registration[] = [];
  const instance = {
    canvasId: 'CanvasDbl01',
    async registerTable(name: string, rows: RegisterRows, options?: RegisterTableOptions) {
      const call: Registration = {
        name,
        options,
        rows: [...(rows as Iterable<Record<string, unknown>>)],
      };
      registrations.push(call);
      return await register(call);
    },
  };
  const canvas = { acquire: async () => instance } as unknown as DataCanvas;
  return { canvas, registrations };
}

/**
 * Successive requests from one tenant: each call builds its own context (with
 * its own contract, signal, and log) over one shared `ctx.state`, which is where
 * the bridge keeps the tenant's canvas ID and dataframe provenance.
 */
export function tenantSession(tenantId = 'default') {
  const { state } = createMockContext({ tenantId });
  return <const TErrors extends readonly ErrorContract[] | undefined = undefined>(
    options: MockContextOptions<TErrors> = {},
  ) => Object.assign(createMockContext<TErrors>({ ...options, tenantId }), { state });
}
