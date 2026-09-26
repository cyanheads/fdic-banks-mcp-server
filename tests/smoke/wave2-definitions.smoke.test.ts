/**
 * @fileoverview Smoke check of the five Wave 2 tool definitions and the full
 * registration list, in both drop modes, against the framework's definition
 * linter (naming, describe-on-fields, format parity, error-contract conformance,
 * the canvas consumer rule), plus each Wave 2 tool's annotations.
 * @module tests/smoke/wave2-definitions.smoke.test
 */

import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getDepositsTool } from '@/mcp-server/tools/definitions/get-deposits.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { queryFinancialsTool } from '@/mcp-server/tools/definitions/query-financials.tool.js';

describe('Wave 2 tool definitions', () => {
  it('are named fdic_* and pass the definition linter, alone and in the full list either way', () => {
    const wave2 = [
      queryFinancialsTool,
      getDepositsTool,
      dataframeDescribeTool,
      dataframeQueryTool,
      dataframeDropTool,
    ];
    expect(wave2.map((t) => t.name)).toEqual([
      'fdic_query_financials',
      'fdic_get_deposits',
      'fdic_dataframe_describe',
      'fdic_dataframe_query',
      'fdic_dataframe_drop',
    ]);
    expect(validateDefinitions({ tools: wave2 }).errors).toEqual([]);
    for (const dropEnabled of [true, false]) {
      expect(validateDefinitions({ tools: buildToolDefinitions({ dropEnabled }) }).errors).toEqual(
        [],
      );
    }
  });

  it('annotate the producers as open-world reads, the canvas reads as closed-world, and drop as destructive', () => {
    for (const producer of [queryFinancialsTool, getDepositsTool]) {
      expect(producer.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    for (const reader of [dataframeDescribeTool, dataframeQueryTool]) {
      expect(reader.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(dataframeDropTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
