/**
 * Merit Aktiva adapter for the LedgerConnector port.
 *
 * Merit is the "auto-post" side of the booking seam: the SDK hands over a
 * document (or a balanced JournalEntry) and Merit posts the double entry
 * itself, so `confirm()` is a no-op. The adapter hides Merit's quirks:
 * caller-assigned invoice numbers, singular `InvoiceRow`, row-level TaxId GUID,
 * required TaxAmount/TotalAmount, YYYYMMDD dates, and the 3-month query cap.
 */
import type {
  Account, AccountCode, Item, JournalEntry, Money, Party, Payment, Posting,
  PurchaseInvoice, Ref, Result, SalesInvoice, StatementSection, TaxRate,
  TrialBalanceRow, DocStatus, Dimension, IsoDate,
} from "../types.js";
import type { Capabilities, EInvoiceCapable, LedgerConnector, ListQuery } from "../port.js";
import { ok, fail, fromThrown } from "../result.js";
import type { MeritHttp } from "./http.js";

const BACKEND_ID = "merit";

const ymd = (d: IsoDate): string => d.replace(/-/g, "");
function fromYmd(s: string): IsoDate {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s.slice(0, 10);
}
function guidRef<E extends string>(entity: E, value: string | undefined): Ref<E> {
  return { entity, backend: BACKEND_ID, value: value ?? "" };
}

export class MeritAdapter implements LedgerConnector, EInvoiceCapable {
  readonly capabilities: Capabilities = {
    backendId: BACKEND_ID,
    label: "Merit Aktiva",
    numbering: "callerAssigned",
    bookingModel: "autoPost",
    refFormat: "guid",
    dimensionModel: "fixedAxes",
    vatScope: "perLine",
    requiresSourceDocOnEntry: false,
    writeTransport: "same",
    maxQuerySpanDays: 92,
    features: {
      payroll: true,
      recurringInvoices: true,
      salesOffers: true,
      fixedAssets: true,
      eInvoiceDelivery: true,
      bankImport: false,
      ocrIntake: false,
      asyncIntake: false,
      taxPackages: false,
      nativePassthrough: false,
    },
  };

  private taxIdByCode = new Map<string, string>();

  constructor(private http: MeritHttp) {}

  async listAccounts(): Promise<Result<Account[]>> {
    try {
      const rows = await this.http.post<MeritAccount[]>("getaccounts");
      return ok(rows.map(toCanonicalAccount));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listTaxRates(): Promise<Result<TaxRate[]>> {
    try {
      const rows = await this.http.post<MeritTax[]>("gettaxes", undefined, { version: "v1" });
      this.taxIdByCode.clear();
      for (const t of rows) this.taxIdByCode.set(t.Code ?? t.Name, t.Id);
      return ok(rows.map((t) => ({ code: t.Code ?? t.Name, ratePct: t.TaxPct })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listParties(): Promise<Result<Party[]>> {
    try {
      const rows = await this.http.post<MeritCustomer[]>("getcustomers", {}, { version: "v2" });
      return ok(rows.map(toCanonicalParty));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async upsertParty(p: Party): Promise<Result<Party>> {
    try {
      const res = await this.http.post<{ CustomerId: string }>(
        "sendcustomer",
        { Name: p.name, RegNo: p.regCode, VatRegNo: p.vatNumber, Email: p.email },
        { version: "v2" },
      );
      return ok({ ...p, id: guidRef("party", res.CustomerId) });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listItems(): Promise<Result<Item[]>> {
    try {
      const rows = await this.http.post<MeritItem[]>("getitems", undefined, { version: "v2" });
      return ok(rows.map((i) => ({ id: guidRef("item", i.Id), code: i.Code, name: i.Description })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createSalesInvoice(inv: SalesInvoice): Promise<Result<SalesInvoice>> {
    try {
      const number = inv.number ?? (await this.nextSalesNumber(inv.docDate));
      const taxIds = await this.resolveTaxIds(inv.lines.map((l) => l.taxCode));
      const body = toMeritSalesInvoice(inv, number, taxIds);
      const res = await this.http.post<MeritInvoiceCreated>("sendinvoice", body, { version: "v1" });
      // Merit posted AR / revenue / VAT itself — nothing to confirm.
      return ok({
        ...inv,
        id: guidRef("salesInvoice", res.InvoiceId),
        number: res.InvoiceNo ?? number,
        status: "confirmed",
        settle: "unpaid",
      });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listSalesInvoices(q: ListQuery): Promise<Result<SalesInvoice[]>> {
    try {
      const rows = await this.http.post<MeritInvoiceFull[]>("getinvoices", clampPeriod(q), { version: "v2" });
      return ok(rows.map(toCanonicalSaleInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createPurchaseInvoice(inv: PurchaseInvoice): Promise<Result<PurchaseInvoice>> {
    try {
      const taxIds = await this.resolveTaxIds(inv.lines.map((l) => l.taxCode));
      const body = toMeritPurchaseInvoice(inv, taxIds);
      const res = await this.http.post<{ PurchInvoiceId: string }>("sendpurchinvoice", body, { version: "v1" });
      return ok({ ...inv, id: guidRef("purchaseInvoice", res.PurchInvoiceId), status: "confirmed", settle: "unpaid" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listPurchaseInvoices(q: ListQuery): Promise<Result<PurchaseInvoice[]>> {
    try {
      const rows = await this.http.post<MeritPurchaseFull[]>("getpurchorders", clampPeriod(q));
      return ok(rows.map(toCanonicalPurchaseInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async recordPayment(p: Payment): Promise<Result<Payment>> {
    try {
      const body = {
        PaymentDate: ymd(p.date),
        BankId: p.bank.value,
        Amount: Number(p.amount.amount),
        PaymentRow: p.allocations.map((a) => ({
          InvoiceId: "account" in a.target ? undefined : a.target.value,
          Amount: Number(a.amount.amount),
        })),
      };
      const res = await this.http.post<{ PaymentId: string }>("sendPaymentV", body, { version: "v1" });
      return ok({ ...p, id: guidRef("payment", res.PaymentId), status: "confirmed" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  /** The seam: a balanced JournalEntry becomes a Merit GL batch; Merit stores the postings. */
  async postJournal(entry: JournalEntry): Promise<Result<JournalEntry>> {
    if (!isBalanced(entry.postings)) {
      return fail({ code: "validation", message: "journal postings do not balance (Σ debit ≠ Σ credit)" });
    }
    try {
      const body = {
        DocNo: entry.docNo,
        BatchDate: ymd(entry.date),
        CurrencyCode: "EUR",
        EntryRow: entry.postings.map(toMeritEntryRow),
      };
      const res = await this.http.post<{ BatchId: string }>("sendglbatch", body, { version: "v1" });
      return ok({ ...entry, id: guidRef("journal", res.BatchId), status: "confirmed" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  /** Auto-post backend: documents are already posted, so confirm reports steady state. */
  async confirm(): Promise<Result<{ status: DocStatus }>> {
    return ok({ status: "confirmed" as DocStatus });
  }

  /** Merit has no VOID lifecycle; the equivalent is deleting the document. */
  async void(id: Ref): Promise<Result<{ status: DocStatus }>> {
    if (id.entity !== "salesInvoice") {
      return fail({ code: "unsupported", message: `Merit cannot void ${id.entity}; delete is only wired for sale invoices` });
    }
    try {
      await this.http.post("deleteinvoice", { Id: id.value }, { version: "v1" });
      return ok({ status: "void" as DocStatus });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async trialBalance(): Promise<Result<TrialBalanceRow[]>> {
    return fail({ code: "unsupported", message: "Merit trial balance not yet wired through the ledger port." });
  }
  async incomeStatement(): Promise<Result<StatementSection[]>> {
    return fail({ code: "unsupported", message: "Merit income statement not yet wired through the ledger port." });
  }

  // --- EInvoiceCapable ---
  async deliverByEInvoice(id: Ref<"salesInvoice">): Promise<Result<{ delivered: boolean }>> {
    try {
      const r = await this.http.post<string>("sendinvoiceaseinv", { Id: id.value, DelivNote: false }, { version: "v2" });
      return ok({ delivered: r === "OK" });
    } catch (e) { return fail(fromThrown(e)); }
  }
  async deliverByEmail(id: Ref<"salesInvoice">): Promise<Result<{ delivered: boolean }>> {
    try {
      await this.http.post("sendinvoicebyemail", { Id: id.value, DelivNote: false }, { version: "v2" });
      return ok({ delivered: true });
    } catch (e) { return fail(fromThrown(e)); }
  }

  // --- internals ---
  private async nextSalesNumber(docDate: IsoDate): Promise<string> {
    const rows = await this.http.post<MeritInvoiceFull[]>("getinvoices", { PeriodEnd: ymd(docDate) }, { version: "v2" });
    const max = rows.reduce((m, r) => Math.max(m, Number(r.InvoiceNo) || 0), 0);
    return String(max + 1);
  }

  private async resolveTaxIds(codes: string[]): Promise<Map<string, string>> {
    if (this.taxIdByCode.size === 0) await this.listTaxRates();
    const m = new Map<string, string>();
    for (const c of codes) {
      const id = this.taxIdByCode.get(c);
      if (id) m.set(c, id);
    }
    return m;
  }
}

/* --- pure mappers (canonical <-> Merit JSON) --- */

function clampPeriod(q: ListQuery): { PeriodStart?: string; PeriodEnd?: string } {
  return {
    ...(q.periodStart ? { PeriodStart: ymd(q.periodStart) } : {}),
    ...(q.periodEnd ? { PeriodEnd: ymd(q.periodEnd) } : {}),
  };
}

export function isBalanced(postings: Posting[]): boolean {
  const sum = (pick: (p: Posting) => Money | undefined) =>
    postings.reduce((acc, p) => acc + Number(pick(p)?.amount ?? 0), 0);
  return Math.abs(sum((p) => p.debit) - sum((p) => p.credit)) < 0.005;
}

function splitDimensions(dims?: Dimension[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of dims ?? []) {
    const v = typeof d.value === "string" ? d.value : d.value.value;
    if (d.axis === "project") out.ProjectCode = v;
    else if (d.axis === "costCenter") out.CostCenterCode = v;
    else if (d.axis === "department") out.DepartmentCode = v;
  }
  return out;
}

export function toMeritEntryRow(p: Posting): Record<string, unknown> {
  return {
    AccountCode: p.account,
    Debit: p.debit ? Number(p.debit.amount) : 0,
    Credit: p.credit ? Number(p.credit.amount) : 0,
    Memo: p.memo,
    ...splitDimensions(p.dimensions),
  };
}

function itemPayload(item: SalesInvoice["lines"][number]["item"], description?: string): Record<string, unknown> {
  if (item && "value" in item) return { Id: item.value, Description: description };
  return { Code: item?.code, Description: item?.name ?? description, UOMName: item?.unit ?? "tk" };
}

export function toMeritSalesInvoice(inv: SalesInvoice, number: string, taxIds: Map<string, string>): Record<string, unknown> {
  let grand = 0;
  const InvoiceRow = inv.lines.map((l) => {
    grand += Number(l.quantity) * Number(l.unitPrice.amount);
    return {
      Item: itemPayload(l.item, l.description),
      Quantity: Number(l.quantity),
      Price: Number(l.unitPrice.amount),
      TaxId: taxIds.get(l.taxCode),
      Account: l.account,
    };
  });
  const customer = "name" in inv.customer
    ? { Name: inv.customer.name, RegNo: inv.customer.regCode }
    : { Id: inv.customer.value };
  return {
    Customer: customer,
    DocDate: ymd(inv.docDate),
    TransactionDate: ymd(inv.docDate),
    DueDate: ymd(inv.dueDate),
    InvoiceNo: number,
    CurrencyCode: inv.currency,
    PriceInclVat: false,
    InvoiceRow,
    TaxAmount: [...taxIds.values()].map((Id) => ({ TaxId: Id, Amount: 0 })),
    TotalAmount: inv.total ? Number(inv.total.amount) : grand,
    FComment: inv.footerNote,
  };
}

export function toMeritPurchaseInvoice(inv: PurchaseInvoice, taxIds: Map<string, string>): Record<string, unknown> {
  const vendor = "name" in inv.vendor
    ? { Name: inv.vendor.name, RegNo: inv.vendor.regCode }
    : { Id: inv.vendor.value };
  return {
    Vendor: vendor,
    BillNo: inv.vendorBillNo,
    DocDate: ymd(inv.docDate),
    DueDate: ymd(inv.dueDate),
    CurrencyCode: inv.currency,
    PurchaseInvoiceRow: inv.lines.map((l) => ({
      Item: itemPayload(l.item, l.description),
      Quantity: Number(l.quantity),
      Price: Number(l.unitPrice.amount),
      TaxId: taxIds.get(l.taxCode),
      Account: l.account,
    })),
  };
}

function meritAccountType(t: string | undefined): Account["type"] {
  switch (t) {
    case "A": return "asset";
    case "L": return "liability";
    case "O": return "equity";
    case "I": return "revenue";
    default: return "expense";
  }
}
function toCanonicalAccount(a: MeritAccount): Account {
  return {
    id: guidRef("account", a.Id),
    code: a.Code,
    name: a.Name,
    type: meritAccountType(a.Type),
    requiresDimension: a.HasDimensions ?? false,
  };
}
function toCanonicalParty(c: MeritCustomer): Party {
  return { id: guidRef("party", c.Id), kind: "customer", name: c.Name, regCode: c.RegNo, vatNumber: c.VatRegNo };
}
function meritSettle(r: MeritInvoiceFull): SalesInvoice["settle"] {
  if (r.PaidAmount != null && r.TotalAmount != null && r.PaidAmount >= r.TotalAmount) return "paid";
  if (r.PaidAmount != null && r.PaidAmount > 0) return "partial";
  return "unpaid";
}
function toCanonicalSaleInvoice(r: MeritInvoiceFull): SalesInvoice {
  return {
    id: guidRef("salesInvoice", r.InvoiceId),
    status: "confirmed",
    settle: meritSettle(r),
    number: r.InvoiceNo,
    customer: guidRef("party", r.CustomerId),
    docDate: fromYmd(r.DocDate),
    dueDate: fromYmd(r.DueDate ?? r.DocDate),
    currency: r.CurrencyCode ?? "EUR",
    lines: [],
    total: { amount: String(r.TotalAmount ?? 0), currency: r.CurrencyCode ?? "EUR" },
  };
}
function toCanonicalPurchaseInvoice(r: MeritPurchaseFull): PurchaseInvoice {
  return {
    id: guidRef("purchaseInvoice", r.Id),
    status: "confirmed",
    vendor: guidRef("party", r.VendorId),
    vendorBillNo: r.BillNo,
    docDate: fromYmd(r.DocDate),
    dueDate: fromYmd(r.DueDate ?? r.DocDate),
    currency: r.CurrencyCode ?? "EUR",
    lines: [],
  };
}

/* --- trimmed Merit response shapes --- */
interface MeritAccount { Id: string; Code: AccountCode; Name: string; Type?: string; HasDimensions?: boolean; }
interface MeritTax { Id: string; Code?: string; Name: string; TaxPct: number; }
interface MeritCustomer { Id: string; Name: string; RegNo?: string; VatRegNo?: string; }
interface MeritItem { Id: string; Code?: string; Description: string; }
interface MeritInvoiceCreated { InvoiceId: string; InvoiceNo?: string; CustomerId?: string; }
interface MeritInvoiceFull { InvoiceId: string; InvoiceNo?: string; CustomerId?: string; DocDate: string; DueDate?: string; CurrencyCode?: string; TotalAmount?: number; PaidAmount?: number; }
interface MeritPurchaseFull { Id: string; VendorId?: string; BillNo: string; DocDate: string; DueDate?: string; CurrencyCode?: string; }
