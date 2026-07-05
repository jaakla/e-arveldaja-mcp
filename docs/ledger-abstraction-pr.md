# PR: Multi-backend ledger abstraction (Merit Aktiva first)

## Summary

Adds an intermediate **ports-and-adapters** layer (`src/ledger/`) so this
server can drive other Estonian bookkeeping systems through one canonical
model, with **Merit Aktiva** as the first additional backend. The branch
landed in three waves:

1. **Foundation + first unified tools** — the `LedgerConnector` port,
   canonical types, `Result` envelope, registry, both adapters, and the first
   four `ledger_*` tools (`list_ledger_backends`,
   `ledger_create_sales_invoice`, `ledger_record_payment`,
   `ledger_post_journal`). Purely additive.
2. **Write-tool migration** — the four existing e-arveldaja write tools
   (`create_sale_invoice`, `create_purchase_invoice`, `create_journal`,
   `confirm_transaction`) now route through the `EarveldajaAdapter` with
   unchanged public behaviour (see "Worked migrations" below).
3. **Merit-only ledger session + full CRUD surface** — six `ledger_list_*`
   read tools, `ledger_create_purchase_invoice`, `ledger_confirm`,
   `ledger_void` (13 `ledger_*` tools total), honest credential reporting in
   discovery, default-backend fallback to the first configured backend, and a
   "ledger session" boot mode so the server is usable with Merit credentials
   and **no** e-arveldaja credentials. Supporting change: OCR
   (`@llamaindex/liteparse`) is now loaded lazily so a missing native binary
   no longer prevents boot on platforms Merit-only sessions may run on.

The 13 `ledger_*` tools plus 133 e-arveldaja tools put the default surface at
146. The remaining ~129 e-arveldaja tools and all workflow prompts stay
e-arveldaja-specific by design.

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
src/tools/ledger-tools.ts      the 13 ledger_* tools: list_ledger_backends,
                               6 ledger_list_* reads, 4 writes (sales/purchase
                               invoice, payment, journal), confirm + void
src/index.ts                   registerLedgerTools + the ledger-session boot
                               path (ledgerOnlySession: banner + instructions
                               when only a non-e-arveldaja backend is configured)
src/__integration__/merit-adapter.integration.test.ts   opt-in live smoke test
src/__integration__/mcp-connection.integration.test.ts  + Merit-only ledger-
                               session suite (tool exposure, honest discovery)
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

Default-backend resolution for unqualified `ledger_*` calls:
`EARVELDAJA_LEDGER_DEFAULT_BACKEND` if it names a registered backend, else
e-arveldaja if it has credentials, else the first other configured backend,
else e-arveldaja as a last resort. Discovery reports e-arveldaja's *real*
credential state, so in a Merit-only setup the server boots as a **ledger
session**: Merit is the default, the `ledger_*` tools work against it, and
the e-arveldaja-specific tools stay in setup mode until credentials are
added.

## Safety & conventions

- Adapters never throw across the port boundary — everything returns `Result`.
- Upstream error text is sandbox-wrapped (`wrapUntrustedOcr`) before reaching
  the LLM, matching the repo's untrusted-text policy.
- Merit signing is verified byte-for-byte against Merit's published test vector.
- New tool annotations reuse the repo presets (`readOnly` / `create`).

## Testing

- `npx tsc --noEmit` — clean (0 errors).
- `npx vitest run src/ledger` — unit tests cover the signer vector, both
  adapters, and the registry (including honest-discovery and Merit-only
  default resolution).
- Full suite: 1350/1352 tests pass; the 2 failures are pre-existing on
  `master` and environment-specific (macOS `/var` symlink resolution, an
  accounting-inbox snapshot), unrelated to this branch. The former
  linux-arm64 test-file load failures are fixed by the lazy OCR loading in
  this branch.
- Opt-in live smoke test runs read-only Merit calls when `MERIT_API_ID` is set:
  `MERIT_API_ID=… MERIT_API_KEY=… npm run test:integration`. The MCP
  integration suite also has a Merit-only ledger-session block (needs only
  Merit credentials).

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

- **Audit logging for the mutating `ledger_*` tools** — the four migrated
  e-arveldaja write tools kept their tool-level audit entries, but
  `ledger_create_*` / `ledger_record_payment` / `ledger_post_journal` /
  `ledger_confirm` / `ledger_void` do not yet write `logs/*.audit.md`.
- **Merit transport hardening** — rate limiting and a retry on 429/network,
  matching the e-arveldaja `HttpClient` posture (`fromThrown` already marks
  those errors `retryable`).
- **Expose more of the port** — `ledger_upsert_party` (both adapters already
  implement `upsertParty`); Merit `trialBalance` / `incomeStatement`; Merit's
  `deliverByEInvoice` / `deliverByEmail` mixin.
- **Per-company backend binding** — connections each pointing at their own
  backend, instead of one env-configured Merit next to the e-arveldaja
  connection set.
- Thin the `api/*` clients where the migrated tools were their only callers.
- Additional adapters (SmartAccounts, SimplBooks) — both fit the `autoPost`
  profile; Directo would exercise the `writeTransport: "separate"` +
  `native()` escape hatch.
