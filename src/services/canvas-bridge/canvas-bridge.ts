/**
 * @fileoverview Adapter between the fdic_ tools and the framework DataCanvas: one
 * shared canvas per tenant, `df_XXXXX_XXXXX` table names, per-table TTL, and
 * provenance (source tool, parameters, column schema and units) kept in
 * `ctx.state` and swept lazily on every operation. A staging budget caps the
 * rows a tenant's live dataframes hold, evicting the oldest first, and the
 * listing can be turned off where every caller shares one tenant. SQL runs
 * through the framework's read-only gate with system catalogs denied; its
 * rejections are rethrown under the calling tool's declared reasons and
 * recovery text.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type {
  CanvasInstance,
  ColumnSchema,
  DataCanvas,
  QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Unit and basis of a staged numeric column, e.g. `roa → percent, quarter_annualized`. */
export interface ColumnUnit {
  basis?: string;
  unit: string;
}

/** Per-table provenance stored in `ctx.state` under `df-meta/<name>`. */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
  columnUnits?: Record<string, ColumnUnit>;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601; the sweep drops the table once it passes. */
  expiresAt: string;
  /** The row cap that bound the source result, when one did. */
  maxRows?: number;
  /** The producing call's input. */
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  /** True when the upstream result held more rows than were staged. */
  truncated: boolean;
}

/** The `dataset` field a producer returns after staging a table. */
export interface StagedDataset {
  expires_at: string;
  name: string;
  row_count: number;
}

export interface StageOptions {
  columnUnits?: Record<string, ColumnUnit>;
  maxRows?: number;
  queryParams: Record<string, unknown>;
  rows: readonly Record<string, unknown>[];
  /** Explicit schema: sniffing reads a ratio column that opens with `0` as an integer. */
  schema: ColumnSchema[];
  sourceTool: string;
  truncated?: boolean;
}

export interface CanvasBridgeOptions {
  /**
   * Whether describe may enumerate the live dataframes; default true. Off where
   * every caller is one tenant (HTTP without auth), since a name is then the only
   * thing that keeps one caller's dataframes from another.
   */
  listing?: boolean;
  /** Rows the tenant's live dataframes may hold together; default 1,000,000. */
  maxStagedRows?: number;
}

export interface BridgeQueryOptions {
  /** Rows returned inline; at most `rowLimit`. */
  preview?: number;
  /** Materialize the result as a new dataframe with a fresh TTL. */
  registerAs?: string;
  /** Hard cap on materialized rows. */
  rowLimit: number;
}

/** The pointer a producer's notice carries once a table is staged. */
export function stagedNotice(dataset: StagedDataset): string {
  return `Full set staged as ${dataset.name} (${dataset.row_count} rows) — use fdic_dataframe_describe with name ${dataset.name} to inspect its columns, then fdic_dataframe_query to analyze it with SQL.`;
}

const META_PREFIX = 'df-meta/';
const CANVAS_ID_KEY = 'canvas-id';
const DEFAULT_MAX_STAGED_ROWS = 1_000_000;
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Framework gate and engine reasons fdic_dataframe_query declares, keyed by the
 * reason the framework raises. A file-reading function caught in the plan rather
 * than the text (`denied_function_in_plan`) is the same caller mistake.
 */
const DECLARED_REASON: Readonly<Record<string, string>> = {
  missing_table: 'missing_table',
  invalid_sql: 'invalid_sql',
  sql_execution_error: 'sql_execution_error',
  non_select_statement: 'non_select_statement',
  multi_statement: 'multi_statement',
  denied_function: 'denied_function',
  denied_function_in_plan: 'denied_function',
  plan_operator_not_allowed: 'plan_operator_not_allowed',
  system_catalog_access: 'system_catalog_access',
  register_as_clash: 'register_as_clash',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonOf(err: unknown): string | undefined {
  return err instanceof McpError && isRecord(err.data) && typeof err.data.reason === 'string'
    ? err.data.reason
    : undefined;
}

/**
 * A framework rejection under the calling tool's declared reason, with the
 * framework's own hint removed so the framework fills in that tool's contract
 * recovery. Anything else passes through unchanged.
 */
function underDeclaredReason(err: unknown): unknown {
  const raised = reasonOf(err);
  const reason = raised === undefined ? undefined : DECLARED_REASON[raised];
  if (!(err instanceof McpError) || reason === undefined) return err;
  const { recovery: _frameworkHint, ...data } = isRecord(err.data) ? err.data : {};
  return new McpError(err.code, err.message, { ...data, reason }, { cause: err });
}

/**
 * SQL with single- and double-quoted literals blanked, so a quoted name never counts
 * as a reference. One left-to-right pass in which a literal left open runs to the end
 * of the statement: no match attempt can fail and restart at a later quote, so the
 * scan is linear in the SQL's length.
 */
export function stripStringLiterals(sql: string): string {
  return sql.replace(
    /'(?:[^'\\]|\\(?:[\s\S]|$)|'')*(?:'|$)|"(?:[^"\\]|\\(?:[\s\S]|$)|"")*(?:"|$)/g,
    (literal) => (literal.startsWith("'") ? "''" : '""'),
  );
}

export class CanvasBridge {
  /** Whether describe may enumerate the live dataframes. */
  readonly listing: boolean;
  private readonly maxStagedRows: number;

  constructor(
    private readonly canvas: DataCanvas,
    options: CanvasBridgeOptions = {},
  ) {
    this.listing = options.listing ?? true;
    this.maxStagedRows = options.maxStagedRows ?? DEFAULT_MAX_STAGED_ROWS;
  }

  /**
   * Registers rows as a new `df_<id>` table on the tenant's shared canvas, then
   * evicts the oldest dataframes past the staging budget.
   * A failure is logged and returns `undefined` so the producer's inline answer
   * stands — unless the call was cancelled, which is rethrown as a cancellation.
   */
  async stage(ctx: Context, options: StageOptions): Promise<StagedDataset | undefined> {
    try {
      const instance = (await this.sweepExpired(ctx)) ?? (await this.createSharedCanvas(ctx));
      const tableName = mintTableName();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const result = await instance.registerTable(tableName, options.rows, {
        schema: options.schema,
        ttlMs,
        signal: ctx.signal,
      });
      const now = Date.now();
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: options.truncated ?? false,
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
        columnSchema: options.schema,
        ...(options.columnUnits ? { columnUnits: options.columnUnits } : {}),
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
      await this.evictToBudget(ctx, instance, result.tableName);
      ctx.log.info('Dataframe staged', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });
      return { name: result.tableName, row_count: result.rowCount, expires_at: meta.expiresAt };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('Dataframe staging failed; the inline preview stands', {
        sourceTool: options.sourceTool,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  /**
   * Live dataframes with provenance, newest first; one entry (or none) when `name`
   * is set. A caller checks `listing` before asking without a name.
   */
  async describe(ctx: Context, name?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
    if (name) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${name}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One read-only SELECT against the shared canvas, through the framework gate
   * with system catalogs denied. A `df_` name the SQL references that is not
   * staged fails as `missing_table` before the gate runs. `registerAs` keeps the
   * whole result, whatever `rowLimit` says, so its size is known only once it is
   * materialized: past the staging budget on its own it is dropped and fails as
   * `register_as_too_large`; otherwise the oldest dataframes make room for it.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions,
  ): Promise<{ meta?: DataframeMeta; result: QueryResult }> {
    const live = await this.sweepExpired(ctx);
    await this.assertReferencedTablesExist(ctx, sql);
    const { registerAs } = options;
    if (registerAs && (await ctx.state.get(`${META_PREFIX}${registerAs}`)) !== null) {
      throw validationError(
        `A dataframe named ${registerAs} already exists; register_as needs an unused name.`,
        { reason: 'register_as_clash', tableName: registerAs },
      );
    }
    const instance = live ?? (await this.createSharedCanvas(ctx));
    const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        rowLimit: options.rowLimit,
        ...(options.preview !== undefined ? { preview: options.preview } : {}),
        ...(registerAs ? { registerAs, ttlMs } : {}),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (err) {
      throw underDeclaredReason(err);
    }
    if (!result.tableName) return { result };

    const tableName = result.tableName;
    if (result.rowCount > this.maxStagedRows) {
      await instance.drop(tableName);
      throw validationError(
        `register_as would keep ${result.rowCount.toLocaleString('en-US')} rows, more than the ${this.maxStagedRows.toLocaleString('en-US')}-row staging budget, so ${tableName} was not saved.`,
        {
          reason: 'register_as_too_large',
          tableName,
          rowCount: result.rowCount,
          maxStagedRows: this.maxStagedRows,
        },
      );
    }
    const [info] = await instance.describe({ tableName });
    const now = Date.now();
    const meta: DataframeMeta = {
      tableName,
      sourceTool: 'fdic_dataframe_query',
      queryParams: { sql },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      rowCount: result.rowCount,
      truncated: false,
      columnSchema: info?.columns ?? [],
    };
    await ctx.state.set(`${META_PREFIX}${tableName}`, meta);
    await this.evictToBudget(ctx, instance, tableName);
    return { result, meta };
  }

  /** Drops a dataframe and its provenance. True when either existed. */
  async drop(ctx: Context, name: string): Promise<boolean> {
    const live = await this.sweepExpired(ctx);
    const key = `${META_PREFIX}${name}`;
    const hadMeta = (await ctx.state.get(key)) !== null;
    await ctx.state.delete(key);
    const droppedTable = live ? await live.drop(name) : false;
    return droppedTable || hadMeta;
  }

  /**
   * A mistyped or expired `df_<id>` would otherwise surface as the framework's
   * generic rejection; string literals are stripped so a quoted name never counts.
   */
  private async assertReferencedTablesExist(ctx: Context, sql: string): Promise<void> {
    const referenced = stripStringLiterals(sql).match(/\bdf_[A-Z0-9]{5}_[A-Z0-9]{5}\b/g) ?? [];
    for (const name of new Set(referenced)) {
      if ((await ctx.state.get(`${META_PREFIX}${name}`)) === null) {
        throw notFound(
          `Dataframe ${name} does not exist: it expired, was dropped to make room for newer dataframes, or was never staged.`,
          { reason: 'missing_table', tableName: name },
        );
      }
    }
  }

  /**
   * Drops the oldest dataframes, provenance included, until the tenant's live rows
   * fit the staging budget. `newest`, the dataframe just saved, is never dropped,
   * so the one call that made room keeps its result. The log names no table:
   * where callers share a tenant, the evicted names are other callers' handles.
   */
  private async evictToBudget(
    ctx: Context,
    instance: CanvasInstance,
    newest: string,
  ): Promise<void> {
    let liveRows = 0;
    const older: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) {
      liveRows += meta.rowCount;
      if (meta.tableName !== newest) older.push(meta);
    }
    if (liveRows <= this.maxStagedRows) return;
    older.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let evicted = 0;
    for (const meta of older) {
      if (liveRows <= this.maxStagedRows) break;
      await instance.drop(meta.tableName);
      await ctx.state.delete(`${META_PREFIX}${meta.tableName}`);
      liveRows -= meta.rowCount;
      evicted++;
    }
    ctx.log.info('Evicted the oldest dataframes to stay within the staging budget', {
      evicted,
      maxStagedRows: this.maxStagedRows,
    });
  }

  /**
   * Runs before every operation: forgets the provenance of an expired canvas,
   * drops each table whose own TTL has passed along with its provenance, and
   * returns the tenant's live canvas, if it has one.
   */
  private async sweepExpired(ctx: Context): Promise<CanvasInstance | undefined> {
    const instance = await this.liveCanvas(ctx);
    const now = new Date().toISOString();
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > now) continue;
      try {
        await instance?.drop(meta.tableName);
      } catch (err) {
        ctx.log.warning('Expired dataframe drop failed', {
          tableName: meta.tableName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await ctx.state.delete(key);
    }
    return instance;
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  /**
   * The tenant's stored canvas while it lives. A canvas that expired took every
   * table with it, so its ID and all provenance go too, and none is returned.
   */
  private async liveCanvas(ctx: Context): Promise<CanvasInstance | undefined> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (!stored) return;
    try {
      return await this.canvas.acquire(stored, ctx);
    } catch (err) {
      if (reasonOf(err) !== 'canvas_not_found') throw err;
    }
    const keys = [CANVAS_ID_KEY];
    for await (const { key } of this.iterateMeta(ctx)) keys.push(key);
    await ctx.state.deleteMany(keys);
    return;
  }

  /** A fresh shared canvas for the tenant, its ID stored for later calls. */
  private async createSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const instance = await this.canvas.acquire(undefined, ctx);
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
  }
}

/** `df_XXXXX_XXXXX` — uppercase letters and digits, 5 + 5. */
function mintTableName(): string {
  const part = () => idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
  return `df_${part()}_${part()}`;
}

let _bridge: CanvasBridge | undefined;

/**
 * Installs the bridge in `setup()`. `canvas` is `undefined` when the framework
 * built no DataCanvas (`CANVAS_PROVIDER_TYPE=none`); producers then keep their
 * inline preview and the dataframe tools report `canvas_unavailable`.
 */
export function initCanvasBridge(
  canvas: DataCanvas | undefined,
  options?: CanvasBridgeOptions,
): void {
  _bridge = canvas ? new CanvasBridge(canvas, options) : undefined;
}

/** The bridge, or `undefined` when no canvas is configured. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
