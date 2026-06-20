/**
 * Canonical accounting model shared by all ledger backends.
 *
 * This is the backend-neutral vocabulary the unified `ledger_*` tools speak.
 * Adapters (src/ledger/<backend>/) translate between these shapes and a
 * specific bookkeeping API (e-arveldaja, Merit Aktiva, …). Nothing here is
 * specific to any one backend; the asymmetries live in the adapters and are
 * surfaced to callers through `Capabilities` (see ./port.ts).
 *
 * Design notes:
 *  - `Money` is an exact decimal string, never a JS float. The SDK owns
 *    rounding; adapters serialize to whatever the backend wants.
 *  - `Ref` is opaque and branded with the minting backend so a Merit GUID
 *    cannot be passed into an e-arveldaja call (or vice-versa) by mistake.
 *  - The booking seam (`JournalEntry` + `Posting`) is a single shape; the
 *    adapter decides whether to push explicit postings (e-arveldaja) or a
 *    document the backend posts itself (Merit).
 */

/** Opaque, backend-scoped identifier. e-arveldaja uses ints, Merit uses GUIDs. */
export interface Ref<TEntity extends string = string> {
  readonly entity: TEntity;
  /** Connector id that minted this ref (e.g. "e-arveldaja", "merit"). */
  readonly backend: string;
  /** Stringified id — opaque to callers. */
  readonly value: string;
}

/** Exact decimal amount + ISO-4217 currency. `amount` is a string, never a float. */
export interface Money {
  amount: string;
  currency: string;
}

/** Backend-neutral calendar date in YYYY-MM-DD form. */
export type IsoDate = string;

/** Uniform result envelope — adapters never throw across the port boundary. */
export type Result<T> =
  | { ok: true; data: T; warnings?: Warning[] }
  | { ok: false; error: LedgerError };

export interface Warning {
  code: string;
  message: string;
  field?: string;
}

export interface LedgerError {
  /** Stable, backend-neutral category callers/tools branch on. */
  code:
    | "validation"
    | "auth"
    | "not_found"
    | "conflict"
    | "unsupported"
    | "rate_limited"
    | "lifecycle"
    | "upstream";
  message: string;
  /** Raw upstream detail; the tool layer sandbox-wraps this before it reaches an LLM. */
  upstreamDetail?: string;
  retryable?: boolean;
}

/**
 * Canonical document lifecycle.
 *  - Merit documents are POSTED on create → they report `confirmed` immediately
 *    and `confirm()` is a no-op.
 *  - e-arveldaja walks draft → confirmed → void via PATCH register/invalidate.
 */
export type DocStatus = "draft" | "confirmed" | "void";

export type SettleStatus = "unpaid" | "partial" | "paid";

export type PartyKind = "customer" | "vendor" | "both";

export interface Party {
  id?: Ref<"party">;
  kind: PartyKind;
  name: string;
  /** Estonian registry (äriregister) code. */
  regCode?: string;
  vatNumber?: string;
  email?: string;
  iban?: string;
  /** Backend extras that don't fit the canonical shape, round-tripped verbatim. */
  raw?: Record<string, unknown>;
}

export interface Item {
  id?: Ref<"item">;
  code?: string;
  name: string;
  unit?: string;
  defaultRevenueAccount?: AccountCode;
  defaultTaxCode?: TaxCode;
}

/** Account identified by its human code; the adapter resolves to its own id. */
export type AccountCode = string;

export interface Account {
  id: Ref<"account">;
  code: AccountCode;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  /** True when the backend forbids direct postings and requires a dimension. */
  requiresDimension?: boolean;
}

/** A tax code referenced canonically; the adapter maps it to the backend form. */
export type TaxCode = string;

export interface TaxRate {
  code: TaxCode;
  ratePct: number;
  validFrom?: IsoDate;
  validTo?: IsoDate;
}

/**
 * Cost dimension. e-arveldaja models these as account sub-accounts; Merit
 * splits them into Department/Project/CostCenter codes; Directo/SmartAccounts
 * use arbitrary named "objects". `axis` is open so every model fits.
 */
export interface Dimension {
  axis: "project" | "costCenter" | "department" | "reportingPerson" | string;
  value: Ref<"dimension"> | string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface InvoiceLine {
  item?: Ref<"item"> | { code?: string; name: string; unit?: string };
  description?: string;
  quantity: string;
  unitPrice: Money;
  taxCode: TaxCode;
  /** Revenue (sales) / expense (purchase) account code. */
  account?: AccountCode;
  dimensions?: Dimension[];
  /** Per-line escape hatch for backend-specific line fields the canonical shape omits. */
  raw?: Record<string, unknown>;
}

export interface SalesInvoice {
  id?: Ref<"salesInvoice">;
  status?: DocStatus;
  settle?: SettleStatus;
  /**
   * Filled by the SDK only when `Capabilities.numbering === "callerAssigned"`
   * (Merit); on series-managed backends the backend assigns it.
   */
  number?: string;
  customer: Ref<"party"> | { name: string; regCode?: string };
  docDate: IsoDate;
  dueDate: IsoDate;
  currency: string;
  lines: InvoiceLine[];
  /** SDK computes & cross-checks; some backends require it explicitly. */
  total?: Money;
  footerNote?: string;
  raw?: Record<string, unknown>;
}

export interface PurchaseInvoice {
  id?: Ref<"purchaseInvoice">;
  status?: DocStatus;
  settle?: SettleStatus;
  vendor: Ref<"party"> | { name: string; regCode?: string };
  /** Supplier's own invoice number — duplicate key. */
  vendorBillNo: string;
  docDate: IsoDate;
  dueDate: IsoDate;
  currency: string;
  lines: InvoiceLine[];
  total?: Money;
  /** e-arveldaja (RPS) requires a source document on every entry. */
  sourceDocument?: Attachment;
  raw?: Record<string, unknown>;
}

export interface PaymentAllocation {
  target: Ref<"salesInvoice"> | Ref<"purchaseInvoice"> | { account: AccountCode };
  amount: Money;
  dimensions?: Dimension[];
}

export interface Payment {
  id?: Ref<"payment">;
  status?: DocStatus;
  /** Bank/GL account the money moved on. */
  bank: Ref<"account">;
  date: IsoDate;
  amount: Money;
  /** What this settles. Empty = an unallocated bank line awaiting booking. */
  allocations: PaymentAllocation[];
  raw?: Record<string, unknown>;
}

/** One side of a double-entry posting. */
export interface Posting {
  account: AccountCode;
  debit?: Money;
  credit?: Money;
  taxCode?: TaxCode;
  dimensions?: Dimension[];
  memo?: string;
  /** Per-posting escape hatch for backend-specific fields the canonical shape omits. */
  raw?: Record<string, unknown>;
}

/**
 * A journal entry the SDK wants to land in the ledger. The adapter decides HOW:
 * push explicit postings (e-arveldaja) or build a GL-batch document the backend
 * posts (Merit). The SDK always speaks balanced postings.
 */
export interface JournalEntry {
  id?: Ref<"journal">;
  status?: DocStatus;
  date: IsoDate;
  docNo?: string;
  /** Must balance (Σ debit === Σ credit). The SDK enforces this. */
  postings: Posting[];
  sourceDocument?: Attachment;
  memo?: string;
  raw?: Record<string, unknown>;
}

export interface TrialBalanceRow {
  account: AccountCode;
  debit: Money;
  credit: Money;
}

export interface StatementSection {
  label: string;
  amount: Money;
  lines?: StatementSection[];
}
