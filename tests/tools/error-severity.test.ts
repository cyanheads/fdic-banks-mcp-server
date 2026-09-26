/**
 * @fileoverview The log severity every declared error reason carries. The tool
 * handler factory logs a failure at the `severity` of the contract entry its
 * `data.reason` names, so an ordinary answer to the caller's input — a miss, an
 * invalid value, an empty scope, a deployment without dataframes — logs below
 * `error` without a stack, while the rate-limit reasons (an upstream or capacity
 * fault) keep `error`. The SQL gate's rejections of a file-reading function or a
 * system catalog log at `warning`: modeled, but an attempt to reach past the
 * staged tables that an operator may want surfaced.
 * @module tests/tools/error-severity.test
 */

import { describe, expect, it } from 'vitest';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** Reasons that stay at the default `error` level. */
const UPSTREAM_FAULTS = new Set(['pacer_shed', 'upstream_rate_limited']);

/** Reasons logged at `warning`. */
const WARNING_REASONS = new Set(['denied_function', 'system_catalog_access']);

const contracts = buildToolDefinitions({ dropEnabled: true }).flatMap((definition) =>
  (definition.errors ?? []).map(
    (entry) =>
      [definition.name, entry.reason, 'severity' in entry ? entry.severity : undefined] as const,
  ),
);

describe('declared error severity', () => {
  it('covers every tool that declares a contract', () => {
    expect(new Set(contracts.map(([tool]) => tool)).size).toBe(9);
  });

  it.each(contracts)(
    '%s declares %s at the level its meaning calls for',
    (_tool, reason, severity) => {
      const expected = UPSTREAM_FAULTS.has(reason)
        ? undefined
        : WARNING_REASONS.has(reason)
          ? 'warning'
          : 'notice';
      expect(severity).toBe(expected);
    },
  );
});
