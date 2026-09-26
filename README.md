<div align="center">
  <h1>@cyanheads/fdic-banks-mcp-server</h1>
  <p><b>Search FDIC-insured banks, Call Report financials, peer rankings, failures, deposit market share via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/fdic-banks-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/fdic-banks-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fdic-banks-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/fdic-banks-mcp-server/releases/latest/download/fdic-banks-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fdic-banks-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmRpYy1iYW5rcy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22fdic-banks-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffdic-banks-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

US bank data from the [FDIC BankFind Suite API](https://api.fdic.gov/banks/docs/), which is public and needs no API key. Find any FDIC-insured bank or savings institution, including closed, merged, and failed ones, then read its quarterly Call Report financials back to 1984, rank it against peers, screen many banks at once, search failures since 1934, and map branch deposits and market share. Runs as a stdio process or a local Streamable HTTP server.

Institutions are keyed by their FDIC certificate number (CERT), which survives renames and charter conversions. Credit unions are insured by the NCUA and are not in this data.

### Tools

| Tool | Description |
|:---|:---|
| `fdic_search_institutions` | Find institutions by name, CERT, location, size, charter class, or holding company; returns the CERT every other tool takes |
| `fdic_get_institution_financials` | One institution's quarterly Call Report history, most recent first, with its profile |
| `fdic_compare_peers` | One institution against a peer group for one quarter: peer median, quartiles, range, percentile, and rank per metric |
| `fdic_query_financials` | Multi-bank, multi-quarter Call Report panel filtered by CERTs, state, asset range, and metric thresholds |
| `fdic_search_failures` | Bank failures and assistance transactions since 1934, with totals, per-method subtotals, and optional grouping |
| `fdic_get_deposits` | Summary of Deposits: an institution's branches and state market share, or a market ranked by deposits with HHI |
| `fdic_list_reference` | Metric catalog, charter classes, failure methods, insurance funds, peer asset bands, and dataset coverage |
| `fdic_dataframe_describe` | List staged dataframes, or describe one by name: provenance, columns, and units |
| `fdic_dataframe_query` | Run one read-only DuckDB `SELECT` across staged dataframes |
| `fdic_dataframe_drop` | Drop a staged dataframe before its TTL; off unless `FDIC_DATAFRAME_DROP_ENABLED=true` |

### Dataframe workflow

1. `fdic_query_financials` and `fdic_get_deposits` return an inline preview. When the full result is larger than `limit`, they also stage it as a `df_XXXXX_XXXXX` table and name it in the response's `dataset` field.
2. Pass that name to `fdic_dataframe_describe` for the table's columns and the unit and basis of each numeric column.
3. Query it with `fdic_dataframe_query`: joins, aggregates, window functions, and CTEs across every staged table. `register_as` saves a result as a new table.
4. Tables expire after `FDIC_DATASET_TTL_SECONDS` (default 24 hours), and the live tables hold 1,000,000 rows together: past that, the oldest are dropped to make room. With `FDIC_DATAFRAME_DROP_ENABLED=true`, `fdic_dataframe_drop` removes one sooner.

Staging runs on DuckDB and is on by default; `CANVAS_PROVIDER_TYPE=none` turns it off. The Claude Desktop `.mcpb` bundle ships without DuckDB's native binding, so there the dataframe tools report an install hint and every other tool works normally.

## Capability reference

### `fdic_search_institutions` <sub>tool</sub>

- Filters: `name` (up to 100 characters; every word must match a current, former, or trade name), up to 50 `certs`, `state`, `city`, `bank_classes`, `min_assets` / `max_assets` (thousands of US dollars), `holding_company_rssd`
- `status` is `active`, `inactive`, or `any`; it defaults to `any` when `name` or `certs` is given and `active` otherwise, and the applied value comes back as `status_filter`
- Up to 100 per page (default 20), paged with `offset` / `next_offset`; records carry `active`, `successor_cert` for merged or failed banks, `holding_company.rssd`, and `matched_on` when a former or trade name matched; requested CERTs with no record land in `missing_certs`

---

### `fdic_get_institution_financials` <sub>tool</sub>

- `cert` required; up to 25 `metrics` (default: a 15-metric health set); `quarters` 1–200 (default 8), optionally bounded by `from_date` / `to_date` as `2025-03-31`, `20250331`, or `2025Q1`
- Rows run most recent first, each a `values` map of metric → number, `null` when not reported; `metric_definitions` gives each metric's FDIC field, unit, and basis
- `quarters_available` counts the quarters in the window before the cap; an unknown CERT fails as `cert_not_found`

---

### `fdic_compare_peers` <sub>tool</sub>

- `cert` required; `report_date` defaults to the latest published quarter (`report_date_defaulted`); up to 20 `metrics`
- Peer group: `peer_asset_band` (`same` by default, `any`, `under_100m`, `100m_1b`, `1b_10b`, `10b_250b`, `over_250b`) plus an optional `peer_state`, or an explicit `peer_certs` list of up to 200, which can't be combined with the band or state (`conflicting_peer_filters`)
- Each comparison returns the institution's `value`, `peer_median`, `peer_p25` / `peer_p75`, `peer_min` / `peer_max`, `percentile`, and `rank` of `rank_of`, over the `peer_count_with_value` peers that reported the metric

---

### `fdic_query_financials` <sub>tool</sub>

- Filters: up to 100 `certs`, `state`, `min_assets` / `max_assets`, and up to 5 `metric_filters` (`metric` with `min` and/or `max` in the metric's unit); up to 30 `metrics`; `from_date` / `to_date`, defaulting to the latest published quarter only
- Inline preview of up to 500 rows (default 50), ordered by `sort_by` / `sort_order`; a panel larger than the preview is staged whole as a dataframe
- The panel is capped at `FDIC_PANEL_MAX_ROWS` (default 50,000) and keeps the newest quarters when it binds; `total_matching`, `rows_fetched`, and `panel_truncated` report what was left out

---

### `fdic_search_failures` <sub>tool</sub>

- Filters: `name`, up to 50 `certs` (events before 1977 carry none), `state`, `from_date` / `to_date` (YYYY-MM-DD), `methods`, `min_assets`; `resolution` is `failure` by default, or `assistance` or `all`
- `summary` totals every matching event, not just the page, with a `by_method` breakdown; `group_by` (`year`, `state`, `method`, `insurance_fund`) adds `groups`
- `estimated_loss_missing_count` counts events without an FDIC loss estimate, and a loss total is `null` when none has one; `sort` by date, loss, or assets, up to 200 per page (default 25)

---

### `fdic_get_deposits` <sub>tool</sub>

- `cert` alone returns the institution's branches and its deposit share in each state (`mode: "institution"`); a geography (`state`, `county`, `city`, `zip`, `msa_code`) ranks every institution in that market with `hhi` (`market`); both give the institution's `position` in the market (`institution_in_market`). `county` and `city` require `state`
- `year` from 1994 on, defaulting to the latest survey (`year_defaulted`); deposits are domestic branch deposits as of June 30, in thousands of US dollars
- Up to 200 branches or ranked institutions inline (default 25); a larger set is staged as a dataframe, and `total_rows` gives the full count

---

### `fdic_list_reference` <sub>tool</sub>

- One `topic` per call: `metrics`, `bank_classes`, `failure_methods`, `insurance_funds`, `peer_asset_bands`, or `coverage`
- `metrics` lists all 49 metric names with FDIC field, unit, basis, caveat, and `in_default_set`; served from built-in tables with no request to FDIC

---

### `fdic_dataframe_describe` <sub>tool</sub>

- `name` (a `df_XXXXX_XXXXX` from a `dataset` field) returns that table in full: source tool, the parameters it was called with, row count, expiry, `column_schema`, and `column_units`
- Without `name`, lists the live tables newest first, 50 per page, paged with `offset` / `next_offset`. Over HTTP with `MCP_AUTH_MODE=none`, where every caller shares one canvas, the listing is off and fails as `listing_unavailable`; a table is reached by its name
- Fails as `canvas_unavailable` when dataframe staging is off

---

### `fdic_dataframe_query` <sub>tool</sub>

- One `SELECT` per call, up to 20,000 characters; writes, DDL, file-reading functions, and system catalogs are rejected with typed reasons (`non_select_statement`, `denied_function`, `system_catalog_access`, and others)
- `row_limit` 1–10,000 (default 1,000) caps rows materialized, with `row_count_capped` when it binds; `preview` limits the rows returned inline
- `register_as` saves the result as a new dataframe with a fresh TTL, or fails as `register_as_too_large` when the result alone passes 1,000,000 rows; `BIGINT` results such as `COUNT(*)` come back as strings

---

### `fdic_dataframe_drop` <sub>tool</sub>

- `name` of a staged dataframe; returns `dropped: true`, or `dropped: false` when nothing by that name was staged
- Disabled unless `FDIC_DATAFRAME_DROP_ENABLED=true`; otherwise tables expire on their TTL

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FDIC-specific:

- Reads four BankFind datasets: institutions (every insured charter, active and inactive), quarterly Call Report financials from 1984, failures and assistance transactions from 1934, and the annual Summary of Deposits from 1994
- Shared request pacer: request starts capped at `FDIC_RATE_LIMIT_RPS`, at most four in flight, a cooldown that holds every caller after an FDIC 429, and an in-process response cache; each call runs under one 45-second budget (55 seconds for a panel), so an error arrives inside a typical 60-second client timeout
- A curated catalog of 49 Call Report metrics with FDIC field code, unit, and basis; `_ytd` metrics accumulate from January 1, and unsuffixed income and return metrics cover a single quarter
- Handles BankFind's quirks: case-sensitive code values, string-typed report dates, absence sentinels, and ratios reported as `0` when a bank did not report them
- Peer statistics, deposit market share, and HHI are computed from every per-institution value, not from samples

Agent-friendly output:

- Provenance on every data response: `data_as_of` (the FDIC index build time), `metric_definitions` with unit and basis, and `report_date_defaulted` / `year_defaulted` flags when the server picked the period
- No fabricated values: unreported metrics come back `null`, and failure loss totals report how many events lack an estimate instead of counting them as zero
- Typed errors with recovery text that names the next call (`cert_not_found`, `conflicting_peer_filters`, `no_report_for_period`); rate-limit errors (`pacer_shed`, `upstream_rate_limited`) carry `retryAfter`
- Staged dataframes keep their provenance and per-column units, so SQL results stay interpretable

## Getting started

Add the following to your MCP client configuration file. No API key is needed.

```json
{
  "mcpServers": {
    "fdic-banks-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/fdic-banks-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "fdic-banks-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/fdic-banks-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "fdic-banks-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/fdic-banks-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No account or API key: the [FDIC BankFind Suite API](https://api.fdic.gov/banks/docs/) is public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/fdic-banks-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd fdic-banks-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# every variable is optional; edit .env to override a default
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FDIC_RATE_LIMIT_RPS` | Maximum request starts per second to `api.fdic.gov` (1–15), shared by every caller of the process. | `8` |
| `FDIC_CACHE_TTL_SECONDS` | Lifetime of the in-process FDIC response cache, in seconds; `0` disables caching. | `3600` |
| `FDIC_PANEL_MAX_ROWS` | Row cap for one `fdic_query_financials` panel (1,000–200,000); the newest quarters are kept when it binds. | `50000` |
| `FDIC_DATASET_TTL_SECONDS` | Lifetime of each staged dataframe, in seconds (minimum 60). | `86400` |
| `FDIC_DATAFRAME_DROP_ENABLED` | Set `true` to enable `fdic_dataframe_drop`. | `false` |
| `CANVAS_PROVIDER_TYPE` | Dataframe engine: `duckdb`, or `none` to turn staging and the dataframe tools off. The server sets `duckdb` when unset. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools, sets the server instructions, and starts the FDIC service and canvas bridge. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), shared input schemas, and markdown helpers. Ten tools. |
| `src/services/fdic` | FDIC BankFind client (request pacer, response cache, query builder, normalization), the metric catalog, and the reference tables. |
| `src/services/canvas-bridge` | Adapter to the framework's DataCanvas: `df_<id>` table names, per-table TTL, and provenance. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `buildToolDefinitions()` in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
