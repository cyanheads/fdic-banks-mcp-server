/**
 * @fileoverview The bundle cleaner strips dependency-shipped agent docs at
 * package roots and keeps runtime `skills/` modules deeper in a package — the MCP
 * SDK's skills extension loads `dist/ext/skills/` at startup — and the
 * post-bundle check in lint-packaging selects the same entries.
 * @module tests/scripts/agent-doc-entry
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL at run time: a static import makes tsc check lint-packaging.ts,
 * whose framework-repo fallback imports a `src/` module this server lacks.
 */
const lintPackaging: { AGENT_DOC_ENTRY: RegExp } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);
const LINT_AGENT_DOC_ENTRY = lintPackaging.AGENT_DOC_ENTRY;

const agentDocs = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/example.md',
  'node_modules/example/skills/guide/SKILL.md',
  'node_modules/example/skills/guide/references/syntax.md',
  'node_modules/@scope/example/skills/guide/SKILL.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/instructions.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/reference.md',
  'node_modules/@scope/outer/node_modules/inner/.agents/instructions.md',
  'node_modules/example/SKILL.md',
  'node_modules/example/docs/SKILL.md',
];

const kept = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/example/dist/framework-skills/runtime.js',
  'node_modules/@scope/example/lib/.agents/runtime.js',
  'node_modules/example/dist/skills.js',
  'skills/fdic-banks-guide/SKILL.md',
  'dist/index.js',
];

describe('AGENT_DOC_ENTRY', () => {
  it('selects package-root agent docs and stray SKILL.md files', () => {
    expect(filterAgentDocEntries(agentDocs)).toEqual(agentDocs);
  });

  it('keeps runtime skills modules, nested directories of the same names, and the published tree', () => {
    expect(filterAgentDocEntries(kept)).toEqual([]);
  });

  it('is the same selector in the cleaner and the post-bundle check', () => {
    expect(LINT_AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(LINT_AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });
});
