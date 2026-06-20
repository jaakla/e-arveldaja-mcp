# PR: Multi-backend ledger abstraction (Merit Aktiva first)

## Summary

Adds an intermediate **ports-and-adapters** layer (`src/ledger/`) so this
server can drive other Estonian bookkeeping systems through one canonical
model, with **Merit Aktiva** as the first additional backend. A small set of
unified `ledger_*` MCP tools route through the new port. The existing
e-arveldaja-specific tools, api clients, cache, auth, and audit log are
**untouched** — this PR is purely additive.

This is the "foundation + unified tools" scope: it proves both backends satisfy
one port and gives an agent a cross-backend surface, without rewiring the 133
existing tools (that migration can follow incrementally).

## Why

e-arveldaja and Merit are both Estonian double-entry systems, but they diverge
on one structural axis: **who posts the double entry.** e-arveldaja is a
*thin-backend, explicit-booking* system (you assemble distributions/postings and
walk `PROJECT → CONFIRMED → VOID`); Merit is a *thick-backend, auto-post* system
(you hand it a document and it posts). A survey of SmartAccounts, SimplBooks,
Erply Books and Directo showed the same clustering. The canonical model captures
the shared 80% (master data, invoices, payments, journals, accounts, VAT,
dimensions); the divergences are expressed as **capabilities**, not forced into
a lowest common denominator.

## What's in it

```
src/ledger/
  types.ts                     canonical model (Money, Ref, Party, Invoice, …)
  port.ts                      LedgerConnector + Capabilities + feature mixins
  result.ts                    Result envelope + HttpError → LedgerError mapping
  registry.ts                  backend selection from ApiContext + env
  index.ts                     barrel
  earveldaja/adapter.ts        wraps existing ApiContext (explicit booking)
  merit/
    signer.ts                  HMAC-SHA256 (Merit's published test vector)
    http.ts                    POST-with-body transport, query-param auth
    config.ts                  MERIT_API_ID/KEY/COUNTRY → MeritConfig
    adapter.ts                 canonical ↔ Merit JSON (auto-post booking)
src/tools/ledger-tools.ts      list_ledger_backends, ledger_create_sales_invoice,
                               ledger_record_payment, ledger_post_journal
src/index.ts                   + registerLedgerTools(scopedServer, api)  (1 line)
src/__integration__/merit-adapter.integration.test.ts   opt-in live smoke test
```

### The booking seam

`JournalEntry` carries balanced `Posting[]`. The Merit adapter maps it to a
`sendglbatch` document; the e-arveldaja adapter posts explicit postings via
`journals.create`. `confirm()` performs the real `PATCH register` on
e-arveldaja and is a no-op on Merit. Callers branch on
`capabilities.bookingModel` rather than on backend name.

### Capability discovery

`Capabilities` declares `numbering` (callerAssigned vs seriesManaged),
`bookingModel`, `refFormat`, `dimensionModel`, `vatScope`,
`requiresSourceDocOnEntry`, `writeTransport`, `maxQuerySpanDays`, and a
`features` flag set. `list_ledger_backends` surfaces this so the agent learns
what each backend supports — and whether Merit is configured at all.

## Configuration

| Env var | Effect |
|---|---|
| `MERIT_API_ID`, `MERIT_API_KEY` | Enable the Merit backend |
| `MERIT_API_COUNTRY` | `EE` (default) or `PL` host |
| `EARVELDAJA_LEDGER_DEFAULT_BACKEND` | Default target for `ledger_*` tools |

Without Merit credentials the registry exposes only e-arveldaja;
`list_ledger_backends` reports Merit as available-but-unconfigured.

## Safety & conventions

- Adapters never throw across the port boundary — everything returns `Result`.
- Upstream error text is sandbox-wrapped (`wrapUntrustedOcr`) before reaching
  the LLM, matching the repo's untrusted-text policy.
- Merit signing is verified byte-for-byte against Merit's published test vector.
- New tool annotations reuse the repo presets (`readOnly` / `create`).

## Testing

- `npx tsc --noEmit` — clean (0 errors).
- `npx vitest run src/ledger` — 21 new unit tests pass (signer vector, both
  adapters, registry).
- Full suite: 1193 tests pass. (5 unrelated test *files* fail to load on
  linux-arm64 due to a pre-existing native-module dependency in
  `document-parser.ts`; unaffected by this PR and green on supported platforms.)
- Opt-in live smoke test runs read-only Merit calls when `MERIT_API_ID` is set:
  `MERIT_API_ID=… MERIT_API_KEY=… npm run test:integration`.

## Worked migrations: the write tools

Four existing write tools now route through the port instead of calling the
`api/*` clients directly — proof that the abstraction can carry real tools with
no behaviour change. Each tool's public schema, validation, audit log,
thrown-error contract, and final API payload are identical:

| Tool | Port method | Notes |
|---|---|---|
| `create_sale_invoice` | `createSalesInvoice` | items → canonical lines (`linesToSaleItems`) |
| `create_purchase_invoice` | `createPurchaseInvoice` | keeps `createAndSetTotals`; vat/gross/VAT-reg ride in `raw` `__`-hints |
| `create_journal` | `postJournal` | postings → canonical postings (`postingToEaPosting`) |
| `confirm_transaction` | `recordPayment` | distributions → allocations; tx id + clients_id in `raw` |

Lossless round-trip: each line/posting's `raw` carries the exact original
backend record, so the adapter reconstructs a byte-identical API payload. The
canonical mappers also let the unified `ledger_*` tools build real e-arveldaja
documents without `raw` fallbacks. A new `unwrap()` helper re-throws a port
failure at the tool boundary so backend errors propagate exactly as the
pre-migration thrown `HttpError` did (preserving the rollback-then-throw
contract that `confirm_transaction`'s test asserts).

## Follow-ups (out of scope here)

- Thin the `api/*` clients where the migrated tools were their only callers.
- Additional adapters (SmartAccounts, SimplBooks) — both fit the `autoPost`
  profile; Directo would exercise the `writeTransport: "separate"` +
  `native()` escape hatch.
