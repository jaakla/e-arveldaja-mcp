# Merit Aktiva API — official reference notes

Working notes distilled from the **official** Merit Aktiva API documentation,
cross-checked against live calls to a demo company. Use this when changing the
Merit adapter (`src/ledger/merit/`).

- Official docs index: <https://api.merit.ee/merit-aktiva-api/>
- Reference manual: <https://api.merit.ee/connecting-robots/reference-manual/>
- Authentication: <https://api.merit.ee/connecting-robots/reference-manual/authentication/>
- Rate limiter: <https://api.merit.ee/connecting-robots/reference-manual/rate-limiter/>
- Access: usable only on Merit **Pro** and **Premium** license levels.

## Authentication (matches `merit/signer.ts` exactly)

- Algorithm: **HMAC-SHA256** (RFC-2104), keyed by the company API key **verbatim**
  (the key is used as-is, not base64-decoded).
- Signed string: `dataToSign = utf8( apiId + timestamp + httpBody )` — concatenated
  in that order (body is the exact bytes on the wire; empty for GET-style reads).
- Signature: `base64( HMAC-SHA256(dataToSign, apiKey) )`.
- Timestamp: numeric **`yyyyMMddHHmmss`**, **UTC**. Requests too old / in the future
  are rejected (no exact tolerance published).
- Passed as **query-string** params on every endpoint: `apiId`, `timestamp`,
  `signature` (signature must be URL-encoded).
- Published test vector (also pinned in `signer.test.ts`):
  - apiId `670fe52f-558a-4be8-ade0-526e01a106d0`
  - apiKey `AoCmZGUfWMMhLJ+Eb6oRF4pAEw9XJP9b/RL5c2Gqk2w=`
  - timestamp `20240624205902`
  - body `{"CustName":"Kliendinimi","CustId":"3a274294-9c60-4a3d-93f0-1874253f073e","OverDueDays":5,"DebtDate":"20220501"}`
  - signature `dt6dkfuj+OfX01YkvvAoN/fekAUGr6AvVlQhUUja9Qc=`

## Base URLs & versions

| Region | v1 | v2 |
|---|---|---|
| Estonia | `https://aktiva.merit.ee/api/v1/` | `https://aktiva.merit.ee/api/v2/` |
| Poland  | `https://program.360ksiegowosc.pl/api/v1/` | `https://program.360ksiegowosc.pl/api/v2/` |

(`merit/config.ts` maps `MERIT_API_COUNTRY=EE|PL` to the host; `http.ts` appends
`/api/{version}/{endpoint}`.) All traffic must be HTTPS; plain HTTP is rejected.

## Rate limit & size limits

- **100 requests/minute** per API key. On exceed: **HTTP 429**, response carries
  `X-RateLimit-Limit` / `-Remaining` / `-Reset` and a **`Retry-After`** header.
  `http.ts` paces to ~1 req/s (well under 100/min) and retries a 429 once. (We do
  not yet read `Retry-After`; a fixed backoff is used.)
- **Max 500 rows** per document (orders, invoices, offers, GL transactions).
- **List queries span at most 3 months** (`getinvoices`, `getpurchorders`,
  `getpayments`, …). Enforced server-side — a wider window returns 400
  `"Periood liiga pikk(max 3 kuud)"`. The adapter defaults an omitted period to
  the last 90 days and bounds the next-invoice-number lookup similarly;
  `capabilities.maxQuerySpanDays = 92`.

## Endpoints used by the adapter

| Canonical op | Endpoint | Ver | Notes |
|---|---|---|---|
| `listAccounts` | `getaccounts` | v1 | result rows: `AccountID`, `Code`, `Name`, `NonActive`, … (docs spell it `NoActive`; live returns **`NonActive`** — we follow live). No type/dimension fields. |
| `listTaxRates` | `gettaxes` | v1 | `Id`, `Code`, `Name`, `TaxPct`. |
| `listParties` | `getcustomers` + `getvendors` | v1 | two registries; ids `CustomerId` / `VendorId`. |
| `upsertParty` (customer) | `sendcustomer` | **v2** | required on add: `Name`, `NotTDCustomer`, `CountryCode`. Response `{Id, Name}`. |
| `upsertParty` (vendor) | `sendvendor` | **v2** | required on add: `Name`, `VatAccountable`, `CountryCode`. **v1 404s** (the reference client's v1 default is wrong). Response `{Id, Name}`. |
| `listItems` | `getitems` | v1 | id `ItemId`; name in `Name`, unit in `UnitofMeasureName`. |
| `createSalesInvoice` | `sendinvoice` | v1 | see invoice payload below. Response `{InvoiceId, InvoiceNo, CustomerId, RefNo, NewCustomer}`. |
| `listSalesInvoices` | `getinvoices` | v2 | result id `SIHId`, dates `DocumentDate`/`DueDate`, gross `TotalSum`, `Paid`. |
| `createPurchaseInvoice` | `sendpurchinvoice` | v1 | see payload below. Response `{VendorId, BillId, BillNo, RefNo, BatchInfo}`. |
| `listPurchaseInvoices` | `getpurchorders` | v1 | result id `PIHId`, `VendorName`, dates `DocumentDate`/`DueDate`. |
| `recordPayment` (vendor) | `sendPaymentV` | v1 (v2 if `CurrencyCode`) | **vendor** payment of a purchase invoice — `VendorName`+`BillNo`+`IBAN`. See "Payments" gap below. |
| `postJournal` | `sendglbatch` | v1 | `DocNo`, `BatchDate`, `EntryRow[]`. |
| `void` (sales only) | `deleteinvoice` | v1 | `{Id}`; returns an Estonian confirmation string. |
| `deliverByEInvoice` | `sendinvoiceaseinv` | v2 | `{Id, DelivNote}` → `"OK"` / `"api-noeinv"`. |
| `deliverByEmail` | `sendinvoicebyemail` | v2 | `{Id, DelivNote}`. |
| bank lookup (payment) | `getbanks` | v1 | `BankId`, `Name`, `IBANCode`, `CurrencyCode`, `AccountCode`. |

### Sales / purchase invoice payload

Per the official create pages, for **both** `sendinvoice` and `sendpurchinvoice`:

- **`TotalAmount` is the NET total — "Amount without VAT".** Merit derives the
  gross itself and returns it as `TotalSum` on the list/detail rows. The adapter
  sends net (Σ `Quantity × Price`); `raw.TotalAmount` overrides.
  - ⚠️ The `jaakla/merit_api` reference client's example shows a *gross*
    `TotalAmount` (100 net → 120), contradicting its own "match the row net
    total" comment. The **official spec wins**; sending gross double-counts VAT
    on a VAT-registered company. (The demo company posts no VAT, so net == gross
    there — which is why earlier tests could not tell the two apart.)
- **`TaxAmount`** is a **required** array of `{TaxId, Amount}`, one entry per
  distinct `TaxId`, carrying the real VAT amount (grouped & summed by TaxId).
- **`InvoiceRow[]`** (singular name) for both documents. Row fields: `Item`
  (`{Code, Description, Type}` — **item code is mandatory**), `Quantity`,
  `Price`, `TaxId` (GUID from `gettaxes`, required).
  - Sales rows carry the account in **`Account`**; purchase rows in
    **`GLAccountCode`** (Str 10).
- Dates `DocDate` / `DueDate` / `TransactionDate` are `yyyymmdd`.
- Purchase invoice: `Vendor` must include both `Id` **and** `Name`; optional
  `CurrencyRate`, `RoundingAmount`, and `Attachment {FileName, FileContent(base64 PDF)}`.
- `getpurchorder` (single detail) nests the invoice under a **`Header`** object
  (`{Header, Lines, Payments, Attachment}`).

## Known gaps / follow-ups (documented, not yet wired)

- **Customer receipts (sales-invoice payments).** The official **`sendpayment`**
  (v1/v2) endpoint takes `CustomerName` + `InvoiceNo` + `Amount` (+ `BankId`/`IBAN`)
  and *can be paid in several parts*. Our `recordPayment` currently only does the
  **vendor** side (`sendPaymentV`, full-amount purchase settlement). Wiring
  `sendpayment` would let the `reconcile-bank` / `import-camt` ledger branches
  record incoming customer payments, closing the "receivables cannot be recorded
  through the port yet" gap noted in those workflows.
- **`Retry-After`.** We retry a 429 once with a fixed delay; honouring the
  header would be more precise.
- **Reports** (`getbalancerep`, `getprofitrep`, GL lists) exist but are not wired
  to `trialBalance` / `incomeStatement`.
- **Not exercised against a VAT-registered company.** The demo company posts 0%
  VAT, so the NET-`TotalAmount` fix and per-rate `TaxAmount` are spec-correct but
  await confirmation on a VAT company.
