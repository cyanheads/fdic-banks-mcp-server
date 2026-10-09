# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-10-09 · 🛡️ Security

Moves to mcp-ts-core 0.13.14: tool errors carry a request id; a numeric string for cert, an integer for name, and null at an optional key are repaired; fdic_dataframe_drop gives its own recovery for an expired canvas; table cells escape backslashes; the image drops musl bindings.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-09-26

The Docker image now publishes to GHCR for linux/amd64 and linux/arm64: production dependencies install on the build platform, so no JavaScript runs under QEMU.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-26

First public release: ten tools over FDIC BankFind — institution search, quarterly Call Report financials, peer comparison, multi-bank panels, failures since 1934, and Summary of Deposits market share, with oversized results staged as SQL-queryable dataframes.
