# fdic-banks-mcp-server - Directory Structure

Generated on: 2026-09-26 18:49:08

```text
fdic-banks-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── compare-peers.tool.ts
│   │       │   ├── dataframe-describe.tool.ts
│   │       │   ├── dataframe-drop.tool.ts
│   │       │   ├── dataframe-query.tool.ts
│   │       │   ├── get-deposits.tool.ts
│   │       │   ├── get-institution-financials.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-reference.tool.ts
│   │       │   ├── query-financials.tool.ts
│   │       │   ├── search-failures.tool.ts
│   │       │   └── search-institutions.tool.ts
│   │       ├── input-schemas.ts
│   │       └── markdown.ts
│   ├── services/
│   │   ├── canvas-bridge/
│   │   │   └── canvas-bridge.ts
│   │   └── fdic/
│   │       ├── asset-bands.ts
│   │       ├── bank-classes.ts
│   │       ├── coverage.ts
│   │       ├── failure-methods.ts
│   │       ├── fdic-service.ts
│   │       ├── insurance-funds.ts
│   │       ├── metric-catalog.ts
│   │       ├── normalize.ts
│   │       ├── peer-stats.ts
│   │       ├── query-builder.ts
│   │       ├── types.ts
│   │       └── us-states.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   └── fdic-records.ts
│   ├── helpers/
│   │   ├── canvas.ts
│   │   ├── fake-fdic.ts
│   │   └── tool-results.ts
│   ├── services/
│   │   ├── canvas-bridge/
│   │   │   └── canvas-bridge.test.ts
│   │   └── fdic/
│   │       ├── fdic-service-deposits-panel.test.ts
│   │       ├── fdic-service.test.ts
│   │       ├── normalize.test.ts
│   │       ├── peer-stats.test.ts
│   │       ├── query-builder.test.ts
│   │       └── static-tables.test.ts
│   ├── smoke/
│   │   ├── wave1-definitions.smoke.test.ts
│   │   └── wave2-definitions.smoke.test.ts
│   ├── tools/
│   │   ├── compare-peers.tool.test.ts
│   │   ├── dataframe-describe.tool.test.ts
│   │   ├── dataframe-drop.tool.test.ts
│   │   ├── dataframe-query.tool.test.ts
│   │   ├── dataframe-workflow.test.ts
│   │   ├── error-severity.test.ts
│   │   ├── get-deposits.tool.test.ts
│   │   ├── get-institution-financials.tool.test.ts
│   │   ├── input-schemas.test.ts
│   │   ├── list-reference.tool.test.ts
│   │   ├── markdown.test.ts
│   │   ├── query-financials.tool.test.ts
│   │   ├── search-failures.tool.test.ts
│   │   ├── search-institutions.tool.test.ts
│   │   └── tool-definitions.test.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
