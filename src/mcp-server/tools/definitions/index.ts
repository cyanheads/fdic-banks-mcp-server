/**
 * @fileoverview The tool registration list handed to createApp() — every fdic_
 * tool, including the one a deployment gates off. fdic_dataframe_drop is wrapped
 * with disabledTool() unless FDIC_DATAFRAME_DROP_ENABLED is on: out of MCP
 * registration, still listed with its enable hint on the HTTP landing page, so
 * the tool count is the same in every deployment.
 * @module mcp-server/tools/definitions
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { comparePeersTool } from './compare-peers.tool.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { getDepositsTool } from './get-deposits.tool.js';
import { getInstitutionFinancialsTool } from './get-institution-financials.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { queryFinancialsTool } from './query-financials.tool.js';
import { searchFailuresTool } from './search-failures.tool.js';
import { searchInstitutionsTool } from './search-institutions.tool.js';

/** Deployment gates that decide how a tool enters the registration list. */
export interface ToolDefinitionOptions {
  /** `FDIC_DATAFRAME_DROP_ENABLED`: false registers fdic_dataframe_drop through disabledTool(). */
  dropEnabled: boolean;
}

/** The tool list for createApp({ tools }); its length is constant across deployments. */
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  return [
    searchInstitutionsTool,
    getInstitutionFinancialsTool,
    comparePeersTool,
    queryFinancialsTool,
    searchFailuresTool,
    getDepositsTool,
    listReferenceTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    options.dropEnabled
      ? dataframeDropTool
      : disabledTool(dataframeDropTool, {
          reason:
            'Dropping dataframes is turned off in this deployment; each staged table expires on its own TTL.',
          hint: 'FDIC_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}
