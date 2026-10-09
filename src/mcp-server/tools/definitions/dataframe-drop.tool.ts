/**
 * @fileoverview fdic_dataframe_drop — drop a staged df_<id> dataframe before its
 * TTL. Idempotent. Registered through disabledTool() unless
 * FDIC_DATAFRAME_DROP_ENABLED=true (see the tool barrel).
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDropTool = tool('fdic_dataframe_drop', {
  title: 'Drop a staged dataframe',
  description:
    'Drop a staged df_<id> dataframe and its provenance before its TTL expires, freeing the shared canvas once an analysis is done. Idempotent: dropping a name that is not staged returns dropped false.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  input: z.object({
    name: z
      .string()
      .regex(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/, 'Expected a dataframe name such as df_AB12C_3DE45')
      .describe('Dataframe to drop (df_XXXXX_XXXXX), as fdic_dataframe_describe lists it.'),
  }),

  output: z.object({
    name: z.string().describe('The dataframe named in the request.'),
    dropped: z
      .boolean()
      .describe(
        'True when it was staged and is now gone; false when nothing by that name existed.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured in this deployment',
      recovery:
        'Dataframes are off in this deployment, so nothing is staged to drop; ask the operator to set CANVAS_PROVIDER_TYPE=duckdb to turn them on.',
      severity: 'notice',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The shared canvas expired while the drop ran, taking every dataframe on it',
      recovery:
        'The canvas holding this dataframe has expired, so nothing is left to drop and no further call is needed.',
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }
    /**
     * The canvas raises canvas_not_found with a hint written for staging ("re-run
     * the tool … to stage fresh data"); re-raised here, it carries this tool's recovery.
     */
    const dropped = await bridge.drop(ctx, input.name).catch((err: unknown) => {
      const reason =
        err instanceof McpError ? (err.data as { reason?: unknown })?.reason : undefined;
      if (reason === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `The canvas holding ${input.name} has expired.`,
          {},
          { cause: err },
        );
      }
      throw err;
    });
    ctx.log.info('Dataframe drop', { name: input.name, dropped });
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped
        ? `Dropped ${result.name} (dropped: true).`
        : `${result.name} was not staged; nothing dropped (dropped: false).`,
    },
  ],
});
