---
name: fdic-banks-guide
description: Chain fdic_* tools through multi-step bank research — a failed or merged bank's last reports and peers, acquisition trees, deposit market share over time, multi-quarter screens, and dataframe SQL. Use when the answer depends on following CERTs across mergers and failures, choosing report dates, separating acquired from organic growth, or staging FDIC results for SQL.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

FDIC BankFind data on each insured bank or savings institution charter: Call Report financials (quarterly from 1984), structure-change history (mergers from 1969, failures from 1970), failures and assistance transactions (from 1934), and the Summary of Deposits (annual from 1994). Keyless.

Financials are each bank charter's own Call Report. A holding company appears only as a name and Fed RSSD ID; its consolidated statements, market data, and filings are not here (an SEC EDGAR server covers listed holding companies). Credit unions are absent. Nothing is intraday: financials land about seven weeks after quarter end, the deposit survey about three months after June 30.

## Identifiers

| Identifier | Obtain from |
|:-----------|:------------|
| CERT | `fdic_search_institutions`; also the `cert` on panel, ranking, and failure rows, `successor_cert`, and a history event's counterparty |
| Holding company RSSD | `holding_company.rssd` on an institution record |
| Report date | A quarter end; a closed bank's last one is `last_report_date` from `fdic_get_institution_financials` |
| Survey year | Summary of Deposits year: deposits as of June 30, which lines up with that year's Q2 Call Report |
| Metric name | `fdic_list_reference` topic `metrics` |
| Change code | History events; `fdic_list_reference` topic `change_codes` maps each to its event type |
| MSA code | `msa_code` on branch rows, which `fdic_get_deposits` returns when called with a CERT |
| `df_` table | The `dataset` field of a staging call, or the `register_as` name you chose |

A failure record names its acquirer by name, city, and state only. Resolve the acquirer's CERT with `fdic_search_institutions` (name plus state), or by walking `successor_cert`. Most failures before 1977 carry no CERT and cannot be joined to institution or financial records.

## Gates

- **Confirm the CERT before chaining.** Name search is fuzzy and also matches former and trade names, so a one-word query can report thousands of matches. Check the top results' status, city, and matched name. A former-name match is the charter that carries that history today.
- **Anchor a closed bank on its last report.** A merged or failed bank keeps its CERT, and `fdic_get_institution_financials` returns its final quarters without any dates passed. `fdic_compare_peers` defaults to the latest published quarter and fails for a closed bank; pass a report date at or before its `last_report_date`. The failure date itself comes from `fdic_search_failures`.
- **`successor_cert` is one hop.** A failed bank can pass through FDIC-run interim charters (a Deposit Insurance National Bank, a bridge bank) before the acquirer takes it. Follow `successor_cert` until an active institution, or take the acquirer from `fdic_search_failures`.
- **Absorption is transitive.** `fdic_get_institution_history` lists only the exits this CERT was party to. Banks it absorbed are events with role `survivor`, under both `merger` and `failure_or_assistance`. Banks those banks absorbed earlier sit in their own histories, so a full acquisition tree takes another history call for each absorbed CERT that absorbed others. `fdic_search_institutions` with the holding company's RSSD and status `any` gives a second view: charters that closed while under that holder, whatever its name was then.
- **Separate acquired from organic change.** A survivor's assets, deposits, and market share jump at the merger quarter or survey year, and the absorbed bank drops out of later rankings and panels. Check the history tool for mergers in the window before calling growth organic, and name the absorbed banks when a gain comes from one.
- **Screens drop partial histories.** Asset and metric thresholds in `fdic_query_financials` apply to each quarter's report, so a bank that crossed the line, opened, or merged out mid-window has fewer rows. Require the full quarter count per CERT before ranking a trend, and report the excluded banks separately.
- **Deposit share is where deposits are booked.** Large banks book deposits at a few offices, so county, city, and ZIP shares describe booking, not customers. Market rankings carry each institution's current or closing name, not its survey-year name, and no headquarters state; restrict a ranking to one state's banks by intersecting it with CERTs from `fdic_search_institutions` filtered to that state.
- **Pick the right return basis.** Unsuffixed `roa`, `roe`, and `net_interest_margin` are single-quarter annualized values. A full-year figure is the `_ytd` metric at the December 31 report.

## Workflows

**A failed bank against its peers.** Resolve the CERT, then read the failure record from `fdic_search_failures` for the date, method, acquirer, and estimated loss. Pull the bank's final quarters from `fdic_get_institution_financials`, then run `fdic_compare_peers` at the last report date. To show the run-up, repeat the peer comparison at earlier quarters, or stage a panel of the bank and its peers.

**Acquisition tree.** Resolve the acquirer, then call `fdic_get_institution_history` filtered to `merger` and `failure_or_assistance`. Keep role `survivor` events, and recurse into each counterparty CERT whose own history has absorptions. Effective dates order the tree; events sharing a transaction number belong to one deal, such as a merger and the rename that came with it.

**Deposit share over time.** Call `fdic_get_deposits` for the same geography at the start year and the latest survey. Full-outer-join the two rankings on `cert`: a bank present only in the earlier year merged, closed, or left the market, and the history tool tells which and names any survivor. Filter to the banks the question covers before ranking the change.

**Multi-quarter screen.** Call `fdic_query_financials` with the asset floor, a quarter range, and the metrics to trend. Prefer rates such as `noncurrent_loan_rate` and `nonperforming_asset_rate` over dollar balances, which mergers inflate. In SQL, keep CERTs with every quarter present, take each bank's first and last value with window functions, and rank the change.

**Staged results.** A panel or deposit set larger than the requested page is staged as a DataCanvas table at offset 0, and the response carries a `dataset` field naming it; a set that fits the page comes back whole inline, with no `dataset`. Call `fdic_dataframe_describe` with the name for the column names and units before writing SQL, then `fdic_dataframe_query` with a read-only query. The tables you stage share one canvas, so a query can join a panel to a deposit ranking, and `register_as` saves a result as a new table. Each table expires at the `expires_at` its staging call reports, and the oldest tables are dropped when the live set exceeds the row budget. Keep the names you receive: a deployment serving unauthenticated HTTP cannot list them.

**When staging is off.** Some deployments, the desktop bundle among them, disable dataframes: no `dataset` field appears, and the dataframe tools fail with `canvas_unavailable`. Page with `next_offset`, or raise `limit` to take a whole panel or ranking in one response. Narrow first, with fewer metrics, CERTs, or quarters (two single-quarter calls answer a first-versus-last question), and compute the comparison from the returned rows.
