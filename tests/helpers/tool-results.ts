/**
 * @fileoverview Readers for the `CallToolResult` that `runToolContract` returns:
 * the rendered `content[]` text, `structuredContent`, and the error envelope —
 * plus the recovery text a definition's error contract declares, so hint
 * assertions track the contract rather than a copy of its prose.
 * @module tests/helpers/tool-results
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';

export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of `content[]`, joined — what a format()-reading client sees. */
export function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** `structuredContent` of a successful call, typed by the caller. */
export function structured<T = Record<string, unknown>>(result: ToolResult): T {
  if (result.isError) {
    throw new Error(`Expected a successful tool result, got an error: ${textOf(result)}`);
  }
  return result.structuredContent as T;
}

export interface ToolErrorEnvelope {
  code: number;
  data?: {
    reason?: string;
    recovery?: { hint?: string };
    retryAfter?: unknown;
    retryable?: boolean;
    [key: string]: unknown;
  };
  message: string;
}

/** The recovery a definition's `errors[]` contract declares for `reason`. */
export function contractRecovery(
  definition: { errors?: readonly { reason: string; recovery: string }[] | undefined },
  reason: string,
): string {
  const entry = definition.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`The contract declares no reason ${reason}`);
  return entry.recovery;
}

/** `structuredContent.error` of a failed call. */
export function toolError(result: ToolResult): ToolErrorEnvelope {
  if (!result.isError) {
    throw new Error(
      `Expected a tool error, got success: ${JSON.stringify(result.structuredContent)}`,
    );
  }
  return (result.structuredContent as { error: ToolErrorEnvelope }).error;
}
