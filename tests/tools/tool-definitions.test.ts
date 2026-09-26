/**
 * @fileoverview Tests for the buildToolDefinitions barrel handed to createApp():
 * ten tools in a fixed order in every deployment, fdic_dataframe_drop live when
 * dropping is enabled and wrapped with disabledTool() and its enable hint when
 * it is not.
 * @module tests/tools/tool-definitions.test
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

const NAMES = [
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
];

describe('buildToolDefinitions', () => {
  it('registers the same ten tools in the same order whether dropping is enabled or not', () => {
    for (const dropEnabled of [true, false]) {
      expect(buildToolDefinitions({ dropEnabled }).map((t) => t.name)).toEqual(NAMES);
    }
  });

  it('passes fdic_dataframe_drop through unwrapped when dropping is enabled', () => {
    expect(buildToolDefinitions({ dropEnabled: true }).at(-1)).toBe(dataframeDropTool);
  });

  it('wraps fdic_dataframe_drop with disabledTool() and the enable hint when dropping is off', () => {
    const off = buildToolDefinitions({ dropEnabled: false }).at(-1);
    expect(off).not.toBe(dataframeDropTool);
    expect(off).toEqual(
      disabledTool(dataframeDropTool, {
        reason: expect.any(String),
        hint: 'FDIC_DATAFRAME_DROP_ENABLED=true',
      }),
    );
    expect(buildToolDefinitions({ dropEnabled: true }).at(-1)).not.toEqual(off);
  });

  it('shares every other definition between the two deployments', () => {
    const on = buildToolDefinitions({ dropEnabled: true });
    const off = buildToolDefinitions({ dropEnabled: false });
    on.slice(0, -1).forEach((definition, index) => {
      expect(off[index]).toBe(definition);
    });
  });
});
