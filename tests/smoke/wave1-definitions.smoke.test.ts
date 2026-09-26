/**
 * @fileoverview Smoke check of the five Wave 1 tool definitions against the
 * framework's definition linter (naming, describe-on-fields, format parity,
 * error-contract conformance). Each definition is imported from its own file.
 * @module tests/smoke/wave1-definitions.smoke.test
 */

import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';
import { comparePeersTool } from '@/mcp-server/tools/definitions/compare-peers.tool.js';
import { getInstitutionFinancialsTool } from '@/mcp-server/tools/definitions/get-institution-financials.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchFailuresTool } from '@/mcp-server/tools/definitions/search-failures.tool.js';
import { searchInstitutionsTool } from '@/mcp-server/tools/definitions/search-institutions.tool.js';

const WAVE_1 = [
  searchInstitutionsTool,
  getInstitutionFinancialsTool,
  comparePeersTool,
  searchFailuresTool,
  listReferenceTool,
];

describe('Wave 1 tool definitions', () => {
  it('are named fdic_* and pass the definition linter without errors', () => {
    expect(WAVE_1.map((t) => t.name)).toEqual([
      'fdic_search_institutions',
      'fdic_get_institution_financials',
      'fdic_compare_peers',
      'fdic_search_failures',
      'fdic_list_reference',
    ]);
    const report = validateDefinitions({ tools: WAVE_1, canvasConsumers: false });
    expect(report.errors).toEqual([]);
  });

  it('annotate every data tool as read-only and open-world, and the reference tool as closed-world', () => {
    for (const t of WAVE_1) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      expect(t.annotations?.openWorldHint).toBe(t !== listReferenceTool);
    }
  });
});
