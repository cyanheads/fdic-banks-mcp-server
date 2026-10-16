/**
 * @fileoverview Selection and read-boundary contracts for bank tools.
 * @module tests/tools/bounded-requests.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { comparePeersTool } from '@/mcp-server/tools/definitions/compare-peers.tool.js';
import { getDepositsTool } from '@/mcp-server/tools/definitions/get-deposits.tool.js';
import { getInstitutionFinancialsTool } from '@/mcp-server/tools/definitions/get-institution-financials.tool.js';
import { queryFinancialsTool } from '@/mcp-server/tools/definitions/query-financials.tool.js';
import { searchFailuresTool } from '@/mcp-server/tools/definitions/search-failures.tool.js';
import { searchInstitutionsTool } from '@/mcp-server/tools/definitions/search-institutions.tool.js';
import { textOf, toolError } from '../helpers/tool-results.js';

describe('selection defaults', () => {
  it('explains every empty selector through both production error surfaces', async () => {
    const results = await Promise.all([
      runToolContract(searchInstitutionsTool, { certs: [] }),
      runToolContract(searchInstitutionsTool, { bank_classes: [] }),
      runToolContract(searchFailuresTool, { certs: [] }),
      runToolContract(searchFailuresTool, { methods: [] }),
      runToolContract(queryFinancialsTool, { certs: [] }),
      runToolContract(comparePeersTool, { cert: 3510, peer_certs: [] }),
    ]);
    for (const result of results) {
      expect(toolError(result)).toMatchObject({ data: { reason: 'invalid_arguments' } });
      expect(textOf(result)).toContain('Provide at least one');
      expect(textOf(result)).toContain('omit');
    }
  });

  it('rejects hard safety ceiling overruns, negative counts and atomic conjunction overflow', () => {
    expect(searchInstitutionsTool.input.safeParse({ limit: 10_001 }).success).toBe(false);
    expect(searchFailuresTool.input.safeParse({ limit: 10_001 }).success).toBe(false);
    expect(
      getInstitutionFinancialsTool.input.safeParse({ cert: 1, quarters: 10_001 }).success,
    ).toBe(false);
    expect(searchInstitutionsTool.input.safeParse({ certs: Array(1001).fill(1) }).success).toBe(
      false,
    );
    expect(
      comparePeersTool.input.safeParse({ cert: 1, peer_certs: Array(1001).fill(1) }).success,
    ).toBe(false);
    expect(
      queryFinancialsTool.input.safeParse({
        metric_filters: Array(6).fill({ metric: 'roa', min: 0 }),
      }).success,
    ).toBe(false);
    expect(queryFinancialsTool.input.safeParse({ limit: -1 }).success).toBe(false);
    expect(getDepositsTool.input.safeParse({ limit: 1.5 }).success).toBe(false);
  });
  it('accepts oversized reads up to hard safety ceilings', () => {
    expect(
      searchInstitutionsTool.input.safeParse({
        limit: 101,
        certs: Array.from({ length: 51 }, (_, i) => i + 1),
      }).success,
    ).toBe(true);
    expect(
      searchFailuresTool.input.safeParse({ limit: 201, methods: Array(20).fill('PA') }).success,
    ).toBe(true);
    expect(
      getInstitutionFinancialsTool.input.safeParse({
        cert: 3510,
        quarters: 201,
        metrics: Array(26).fill('roa'),
      }).success,
    ).toBe(true);
    expect(
      queryFinancialsTool.input.safeParse({ limit: 501, metrics: Array(31).fill('roa') }).success,
    ).toBe(true);
    expect(
      comparePeersTool.input.safeParse({
        cert: 3510,
        peer_certs: Array(201).fill(1),
        metrics: Array(21).fill('roa'),
      }).success,
    ).toBe(true);
    expect(getDepositsTool.input.safeParse({ cert: 3510, limit: 201 }).success).toBe(true);
  });
  it('rejects explicitly empty selections before any request', () => {
    for (const [tool, input] of [
      [searchInstitutionsTool, { certs: [] }],
      [searchInstitutionsTool, { bank_classes: [] }],
      [searchFailuresTool, { certs: [] }],
      [searchFailuresTool, { methods: [] }],
      [queryFinancialsTool, { certs: [] }],
      [comparePeersTool, { cert: 3510, peer_certs: [] }],
    ] as const) {
      expect(tool.input.safeParse(input).success).toBe(false);
    }
  });
  it('retains omitted selectors and empty metric defaults', () => {
    expect(searchInstitutionsTool.input.parse({}).certs).toBeUndefined();
    expect(searchFailuresTool.input.parse({}).methods).toBeUndefined();
    expect(queryFinancialsTool.input.parse({ metrics: [], metric_filters: [] }).metrics).toEqual(
      [],
    );
    expect(comparePeersTool.input.parse({ cert: 3510, metrics: [] }).metrics).toEqual([]);
  });
});
