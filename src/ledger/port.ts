/**
 * The `LedgerConnector` port — the contract every bookkeeping backend adapter
 * implements. Tools and workflows depend on this interface, never on a concrete
 * backend. Backend asymmetries are surfaced through `Capabilities` so callers
 * discover what a backend can do instead of the adapter silently faking it.
 *
 * The capability axes were chosen from a survey of Estonian bookkeeping APIs
 * (e-arveldaja, Merit Aktiva, SmartAccounts, SimplBooks, Erply Books, Directo):
 * they capture the dimensions on which those systems actually diverge.
 */
import type {
  Account, Attachment, IsoDate, Item, JournalEntry, Party, Payment,
  PurchaseInvoice, Ref, Result, SalesInvoice, StatementSection, TaxRate,
  TrialBalanceRow, DocStatus,
} from "./types.js";

export interface Capabilities {
  /** Stable connector id, e.g. "e-arveldaja" or "merit". */
  backendId: string;
  /** Human label for tool output. */
  label: string;
  /** "callerAssigned" (Merit) vs "seriesManaged" (e-arveldaja). */
  numbering: "callerAssigned" | "seriesManaged";
  /**
   * "autoPost"  → documents post on create; confirm() is a no-op.
   * "explicit"  → caller drives draft → confirmed → void.
   */
  bookingModel: "autoPost" | "explicit";
  /** How the backend identifies records. */
  refFormat: "guid" | "int";
  /** "fixedAxes" (Merit Dept/Project/CostCenter) vs "namedObjects" / sub-accounts. */
  dimensionModel: "fixedAxes" | "namedObjects";
  /** Whether VAT is carried per invoice line or only at document level. */
  vatScope: "perLine" | "perDocument";
  /** e-arveldaja (RPS) requires a source document on every entry. */
  requiresSourceDocOnEntry: boolean;
  /** Whether the same transport serves reads and writes (Directo splits them). */
  writeTransport: "same" | "separate";
  /** Max span a list/query may cover, in days (Merit invoice lists: ~92). */
  maxQuerySpanDays?: number;
  /** Optional capability groups the connector implements (see mixins below). */
  features: {
    bankImport?: boolean;
    ocrIntake?: boolean;
    /** Async document/invoice queue (Erply, e-arveldaja import-then-confirm). */
    asyncIntake?: boolean;
    payroll?: boolean;
    recurringInvoices?: boolean;
    salesOffers?: boolean;
    fixedAssets?: boolean;
    eInvoiceDelivery?: boolean;
    taxPackages?: boolean;
    /** Backend exposes an escape-hatch native passthrough (see `native`). */
    nativePassthrough?: boolean;
  };
}

export interface ListQuery {
  periodStart?: IsoDate;
  periodEnd?: IsoDate;
  filter?: Record<string, string>;
  page?: number;
}

/** The core port every connector implements. */
export interface LedgerConnector {
  readonly capabilities: Capabilities;

  // --- master data ---
  listAccounts(q?: ListQuery): Promise<Result<Account[]>>;
  listTaxRates(): Promise<Result<TaxRate[]>>;
  listParties(q?: ListQuery): Promise<Result<Party[]>>;
  upsertParty(p: Party): Promise<Result<Party>>;
  listItems(q?: ListQuery): Promise<Result<Item[]>>;

  // --- documents ---
  createSalesInvoice(inv: SalesInvoice): Promise<Result<SalesInvoice>>;
  listSalesInvoices(q: ListQuery): Promise<Result<SalesInvoice[]>>;
  createPurchaseInvoice(inv: PurchaseInvoice): Promise<Result<PurchaseInvoice>>;
  listPurchaseInvoices(q: ListQuery): Promise<Result<PurchaseInvoice[]>>;
  recordPayment(p: Payment): Promise<Result<Payment>>;

  // --- ledger / booking seam ---
  postJournal(entry: JournalEntry): Promise<Result<JournalEntry>>;

  /**
   * Lifecycle transitions. On an autoPost backend, confirm() reports the steady
   * state without a network call; on an explicit backend it performs the PATCH
   * register / invalidate. Callers check `capabilities.bookingModel` to decide
   * whether a confirm step is meaningful.
   */
  confirm(id: Ref): Promise<Result<{ status: DocStatus }>>;
  void(id: Ref): Promise<Result<{ status: DocStatus }>>;

  // --- reports ---
  trialBalance(asOf: IsoDate): Promise<Result<TrialBalanceRow[]>>;
  incomeStatement(q: ListQuery): Promise<Result<StatementSection[]>>;

  /**
   * Escape hatch for backend-specific power that the canonical model can't
   * express (Directo's arbitrary ERP-style filtering, custom datafields, …).
   * Only present when `capabilities.features.nativePassthrough` is true.
   */
  native?(op: string, payload: unknown): Promise<Result<unknown>>;
}

/* --- Optional capability mixins (present only when features.* is true) --- */

export interface BankImportCapable {
  importStatement(file: Attachment): Promise<Result<Payment[]>>;
}

export interface OcrIntakeCapable {
  extractPurchaseInvoice(file: Attachment): Promise<Result<PurchaseInvoice>>;
}

export interface EInvoiceCapable {
  deliverByEInvoice(id: Ref<"salesInvoice">): Promise<Result<{ delivered: boolean }>>;
  deliverByEmail(id: Ref<"salesInvoice">): Promise<Result<{ delivered: boolean }>>;
}

/* --- Type-safe capability narrowing --- */

export function supportsBankImport(
  c: LedgerConnector,
): c is LedgerConnector & BankImportCapable {
  return c.capabilities.features.bankImport === true;
}

export function supportsOcr(
  c: LedgerConnector,
): c is LedgerConnector & OcrIntakeCapable {
  return c.capabilities.features.ocrIntake === true;
}

export function supportsEInvoice(
  c: LedgerConnector,
): c is LedgerConnector & EInvoiceCapable {
  return c.capabilities.features.eInvoiceDelivery === true;
}
