/**
 * Merit Aktiva adapter for the LedgerConnector port.
 *
 * Merit is the "auto-post" side of the booking seam: the SDK hands over a
 * document (or a balanced JournalEntry) and Merit posts the double entry
 * itself, so `confirm()` is a no-op. The adapter hides Merit's quirks:
 * caller-assigned invoice numbers, singular `InvoiceRow`, row-level TaxId GUID,
 * required TaxAmount/TotalAmount (real VAT amounts, gross total), YYYYMMDD
 * dates, split customer/vendor endpoints, and the 3-month query cap.
 *
 * Payload shapes, endpoint versions, and response field names are validated
 * against the live-tested jaakla/merit_api reference client. Notable traps it
 * documents: purchase invoices use `InvoiceRow` + `GLAccountCode` (not
 * `Account`), Vendor must carry both Id AND Name, create responses use
 * `BillId` / `InvoiceId`, and every canonical `raw` object is spread into the
 * outgoing payload last so backend-specific fields can be added or overridden.
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

  private taxByCode = new Map<string, { id: string; pct: number }>();

  constructor(private http: MeritHttp) {}

  async listAccounts(): Promise<Result<Account[]>> {
    try {
      const rows = await this.http.post<MeritAccount[]>("getaccounts");
      return ok(rows.filter(meritAccountActive).map(toCanonicalAccount));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listTaxRates(): Promise<Result<TaxRate[]>> {
    try {
      const rows = await this.http.post<MeritTax[]>("gettaxes", undefined, { version: "v1" });
      this.taxByCode.clear();
      for (const t of rows) this.taxByCode.set(t.Code ?? t.Name, { id: t.Id, pct: t.TaxPct });
      return ok(rows.map((t) => ({ code: t.Code ?? t.Name, ratePct: t.TaxPct })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  /** Merit keeps customers and vendors in separate registries — return both. */
  async listParties(): Promise<Result<Party[]>> {
    try {
      const customers = await this.http.post<MeritCustomer[]>("getcustomers", {});
      const vendors = await this.http.post<MeritVendor[]>("getvendors", {});
      return ok([
        ...customers.map(toCanonicalCustomer),
        ...vendors.map(toCanonicalVendor),
      ]);
    } catch (e) { return fail(fromThrown(e)); }
  }

  /** Kind-aware: vendors go to sendvendor (v1), customers to sendcustomer (v2). */
  async upsertParty(p: Party): Promise<Result<Party>> {
    try {
      const body = {
        ...(p.id ? { Id: p.id.value } : {}),
        Name: p.name,
        RegNo: p.regCode,
        VatRegNo: p.vatNumber,
        Email: p.email,
        ...(p.iban ? { BankAccount: p.iban } : {}),
        ...(p.raw ?? {}),
      };
      const res = p.kind === "vendor"
        ? await this.http.post<MeritPartyCreated>("sendvendor", body, { version: "v1" })
        : await this.http.post<MeritPartyCreated>("sendcustomer", body, { version: "v2" });
      const id = res.CustomerId ?? res.VendorId ?? res.Id ?? p.id?.value;
      return ok({ ...p, id: guidRef("party", id) });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listItems(): Promise<Result<Item[]>> {
    try {
      const rows = await this.http.post<MeritItem[]>("getitems", {});
      return ok(rows.map((i) => ({
        // Live v1 rows carry ItemId (not Id).
        id: guidRef("item", i.ItemId ?? i.Id),
        code: i.Code,
        name: i.Name ?? i.Description ?? "",
        ...(i.UnitofMeasureName ? { unit: i.UnitofMeasureName } : {}),
      })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createSalesInvoice(inv: SalesInvoice): Promise<Result<SalesInvoice>> {
    try {
      const number = inv.number ?? (await this.nextSalesNumber(inv.docDate));
      const taxes = await this.resolveTaxes(inv.lines.map((l) => l.taxCode));
      const body = toMeritSalesInvoice(inv, number, taxes);
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
      const rows = await this.http.post<MeritInvoiceFull[]>("getinvoices", defaultPeriod(q), { version: "v2" });
      return ok(rows.map(toCanonicalSaleInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createPurchaseInvoice(inv: PurchaseInvoice): Promise<Result<PurchaseInvoice>> {
    try {
      // Merit requires Vendor to carry BOTH Id and Name, even for an existing
      // vendor — resolve the name when the caller passed only a Ref.
      const vendor = await this.vendorPayload(inv.vendor);
      if (!vendor) {
        return fail({ code: "not_found", message: `Vendor ${(inv.vendor as Ref).value} not found in Merit's vendor registry.` });
      }
      const taxes = await this.resolveTaxes(inv.lines.map((l) => l.taxCode));
      const body = toMeritPurchaseInvoice(inv, taxes, vendor);
      const res = await this.http.post<MeritPurchaseCreated>("sendpurchinvoice", body, { version: "v1" });
      return ok({ ...inv, id: guidRef("purchaseInvoice", res.BillId ?? res.PurchInvoiceId), status: "confirmed", settle: "unpaid" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listPurchaseInvoices(q: ListQuery): Promise<Result<PurchaseInvoice[]>> {
    try {
      const rows = await this.http.post<MeritPurchaseFull[]>("getpurchorders", defaultPeriod(q));
      return ok(rows.map(toCanonicalPurchaseInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  /**
   * Merit's sendPaymentV is a flat vendor-payment document: one bill per call,
   * identified by BillNo + VendorName (not by GUID), paid to the vendor's
   * IBAN. The adapter resolves BillNo/VendorName from a purchaseInvoice ref
   * via getpurchorder and the IBAN from the vendor registry; `raw` fields
   * (BillNo, VendorName, IBAN, CustName, …) take precedence and are spread
   * into the payload last.
   */
  async recordPayment(p: Payment): Promise<Result<Payment>> {
    try {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      if (p.allocations.length !== 1) {
        return fail({ code: "validation", message: "Merit sendPaymentV settles exactly one bill per call — pass a single allocation." });
      }
      const target = p.allocations[0]!.target;

      let billNo = typeof raw.BillNo === "string" ? raw.BillNo : undefined;
      let vendorName = typeof raw.VendorName === "string" ? raw.VendorName : undefined;
      if (!billNo || !vendorName) {
        if ("account" in target || target.entity !== "purchaseInvoice") {
          return fail({
            code: "unsupported",
            message: "Merit payments are wired for purchase-invoice settlement: allocate to a purchaseInvoice ref, or pass raw.BillNo / raw.VendorName explicitly.",
          });
        }
        const detail = await this.http.post<MeritPurchaseFull>("getpurchorder", { Id: target.value, SkipAttachment: true });
        billNo ??= detail.BillNo;
        vendorName ??= detail.VendorName;
      }

      let iban = typeof raw.IBAN === "string" ? raw.IBAN : undefined;
      if (!iban && vendorName) {
        const vendors = await this.http.post<MeritVendor[]>("getvendors", { Name: vendorName });
        iban = vendors.find((v) => v.Name === vendorName)?.BankAccount;
      }
      if (!iban) {
        return fail({ code: "validation", message: `IBAN missing for vendor "${vendorName ?? "?"}" — pass raw.IBAN or set the vendor's bank account in Merit.` });
      }

      const foreignCurrency = p.amount.currency && p.amount.currency !== "EUR";
      const body: Record<string, unknown> = {
        ...(p.bank.value ? { BankId: p.bank.value } : {}),
        VendorName: vendorName,
        BillNo: billNo,
        Amount: Number(p.amount.amount),
        IBAN: iban,
        PaymentDate: ymd(p.date),
        ...(foreignCurrency ? { CurrencyCode: p.amount.currency } : {}),
        ...raw,
      };
      // Merit routes multi-currency payments through v2 (reference-client behaviour).
      const version = body.CurrencyCode ? "v2" : "v1";
      const res = await this.http.post<MeritPaymentCreated>("sendPaymentV", body, { version });
      return ok({ ...p, id: guidRef("payment", res.InvoiceId ?? res.PaymentId), status: "confirmed" });
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
    // Merit caps invoice-list queries at ~3 months, so bound the window.
    const rows = await this.http.post<MeritInvoiceFull[]>(
      "getinvoices",
      { PeriodStart: ymd(shiftDays(docDate, -90)), PeriodEnd: ymd(docDate) },
      { version: "v2" },
    );
    const max = rows.reduce((m, r) => Math.max(m, Number(r.InvoiceNo) || 0), 0);
    return String(max + 1);
  }

  private async resolveTaxes(codes: string[]): Promise<Map<string, { id: string; pct: number }>> {
    if (this.taxByCode.size === 0) await this.listTaxRates();
    const m = new Map<string, { id: string; pct: number }>();
    for (const c of codes) {
      const tax = this.taxByCode.get(c);
      if (tax) m.set(c, tax);
    }
    return m;
  }

  /** Resolve a canonical vendor into Merit's required {Id, Name} (or {Name, RegNo} for a new vendor). */
  private async vendorPayload(v: PurchaseInvoice["vendor"]): Promise<Record<string, unknown> | undefined> {
    if ("name" in v) return { Name: v.name, ...(v.regCode ? { RegNo: v.regCode } : {}) };
    const vendors = await this.http.post<MeritVendor[]>("getvendors", {});
    const match = vendors.find((x) => (x.VendorId ?? x.Id) === v.value);
    return match ? { Id: v.value, Name: match.Name } : undefined;
  }
}

/* --- pure mappers (canonical <-> Merit JSON) --- */

function shiftDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Merit's list endpoints require a period and cap it at ~3 months; default to
 * the last 90 days when the caller gave none (reference-client behaviour).
 */
function defaultPeriod(q: ListQuery): { PeriodStart: string; PeriodEnd: string } {
  const today = new Date().toISOString().slice(0, 10);
  const end = q.periodEnd ?? today;
  const start = q.periodStart ?? shiftDays(end, -90);
  return { PeriodStart: ymd(start), PeriodEnd: ymd(end) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Merit requires a TaxAmount array with the REAL per-rate VAT amounts (an
 * entry per distinct TaxId, zero included) and a gross TotalAmount. Returns
 * both computed from the lines' net amounts (PriceInclVat is false).
 */
function computeTaxTotals(
  lines: Array<{ quantity: string; unitPrice: Money; taxCode: string }>,
  taxes: Map<string, { id: string; pct: number }>,
): { TaxAmount: Array<{ TaxId: string; Amount: number }>; net: number; tax: number } {
  const byTaxId = new Map<string, number>();
  let net = 0;
  for (const l of lines) {
    const lineNet = Number(l.quantity) * Number(l.unitPrice.amount);
    net += lineNet;
    const tax = taxes.get(l.taxCode);
    if (!tax) continue;
    byTaxId.set(tax.id, (byTaxId.get(tax.id) ?? 0) + lineNet * (tax.pct / 100));
  }
  const TaxAmount = [...byTaxId.entries()].map(([TaxId, amount]) => ({ TaxId, Amount: round2(amount) }));
  const tax = round2(TaxAmount.reduce((s, t) => s + t.Amount, 0));
  return { TaxAmount, net: round2(net), tax };
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

export function toMeritSalesInvoice(
  inv: SalesInvoice,
  number: string,
  taxes: Map<string, { id: string; pct: number }>,
): Record<string, unknown> {
  const { TaxAmount, net, tax } = computeTaxTotals(inv.lines, taxes);
  const InvoiceRow = inv.lines.map((l) => ({
    Item: itemPayload(l.item, l.description),
    Quantity: Number(l.quantity),
    Price: Number(l.unitPrice.amount),
    TaxId: taxes.get(l.taxCode)?.id,
    // Sales invoice rows use `Account` (purchase rows use GLAccountCode).
    Account: l.account,
    ...(l.raw ?? {}),
  }));
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
    TaxAmount,
    // TotalAmount is the GROSS sum (net + VAT) — reference-client verified.
    TotalAmount: inv.total ? Number(inv.total.amount) : round2(net + tax),
    ...(inv.footerNote ? { FComment: inv.footerNote } : {}),
    ...(inv.raw ?? {}),
  };
}

export function toMeritPurchaseInvoice(
  inv: PurchaseInvoice,
  taxes: Map<string, { id: string; pct: number }>,
  vendor: Record<string, unknown>,
): Record<string, unknown> {
  const { TaxAmount, net, tax } = computeTaxTotals(inv.lines, taxes);
  return {
    Vendor: vendor,
    BillNo: inv.vendorBillNo,
    DocDate: ymd(inv.docDate),
    TransactionDate: ymd(inv.docDate),
    DueDate: ymd(inv.dueDate),
    CurrencyCode: inv.currency,
    CurrencyRate: 1.0,
    // Purchase invoices use `InvoiceRow` too (NOT PurchaseInvoiceRow) and the
    // row account field is `GLAccountCode` (sales rows use `Account`).
    InvoiceRow: inv.lines.map((l) => ({
      Item: { ...itemPayload(l.item, l.description), TaxId: taxes.get(l.taxCode)?.id },
      Quantity: Number(l.quantity),
      Price: Number(l.unitPrice.amount),
      TaxId: taxes.get(l.taxCode)?.id,
      GLAccountCode: l.account,
      ...(l.raw ?? {}),
    })),
    TaxAmount,
    TotalAmount: inv.total ? Number(inv.total.amount) : round2(net + tax),
    RoundingAmount: 0,
    ...(inv.sourceDocument
      ? { Attachment: { FileName: inv.sourceDocument.filename, FileContent: inv.sourceDocument.contentBase64 } }
      : {}),
    ...(inv.raw ?? {}),
  };
}

function toCanonicalAccount(a: MeritAccount): Account {
  // Merit's getaccounts exposes no account-type or dimension flags, so those
  // canonical fields are omitted rather than guessed (verified against the
  // live v1 response: AccountID / Code / Name / NonActive / IsParent / Tax*).
  return {
    id: guidRef("account", a.AccountID),
    code: a.Code,
    name: a.Name,
  };
}
function meritAccountActive(a: MeritAccount): boolean {
  return !(a.NonActive === true || a.NonActive === "True");
}
function toCanonicalCustomer(c: MeritCustomer): Party {
  // Live v1 rows carry CustomerId (not Id).
  return {
    id: guidRef("party", c.CustomerId ?? c.Id),
    kind: "customer",
    name: c.Name,
    regCode: c.RegNo,
    vatNumber: c.VatRegNo,
    ...(c.Email ? { email: c.Email } : {}),
    ...(c.BankAccount ? { iban: c.BankAccount } : {}),
  };
}
function toCanonicalVendor(v: MeritVendor): Party {
  // Live v1 rows carry VendorId (not Id).
  return {
    id: guidRef("party", v.VendorId ?? v.Id),
    kind: "vendor",
    name: v.Name,
    regCode: v.RegNo,
    vatNumber: v.VatRegNo,
    ...(v.Email ? { email: v.Email } : {}),
    ...(v.BankAccount ? { iban: v.BankAccount } : {}),
  };
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
    // Purchase rows identify the invoice as BillId (reference-client verified).
    id: guidRef("purchaseInvoice", r.BillId ?? r.Id),
    status: "confirmed",
    vendor: guidRef("party", r.VendorId),
    vendorBillNo: r.BillNo,
    docDate: fromYmd(r.DocDate),
    dueDate: fromYmd(r.DueDate ?? r.DocDate),
    currency: r.CurrencyCode ?? "EUR",
    lines: [],
  };
}

/* --- trimmed Merit response shapes (field names validated against the
       jaakla/merit_api reference client and its live tests) --- */
interface MeritAccount { AccountID: string; Code: AccountCode; Name: string; NonActive?: boolean | string; IsParent?: string; }
interface MeritTax { Id: string; Code?: string; Name: string; TaxPct: number; }
interface MeritCustomer { CustomerId?: string; Id?: string; Name: string; RegNo?: string; VatRegNo?: string; Email?: string; BankAccount?: string; }
interface MeritVendor { VendorId?: string; Id?: string; Name: string; RegNo?: string; VatRegNo?: string; Email?: string; BankAccount?: string; }
interface MeritItem { ItemId?: string; Id?: string; Code?: string; Name?: string; Description?: string; UnitofMeasureName?: string; }
interface MeritPartyCreated { CustomerId?: string; VendorId?: string; Id?: string; }
interface MeritInvoiceCreated { InvoiceId: string; InvoiceNo?: string; CustomerId?: string; RefNo?: string; }
interface MeritInvoiceFull { InvoiceId: string; InvoiceNo?: string; CustomerId?: string; DocDate: string; DueDate?: string; CurrencyCode?: string; TotalAmount?: number; PaidAmount?: number; }
interface MeritPurchaseCreated { BillId?: string; PurchInvoiceId?: string; BillNo?: string; VendorId?: string; }
interface MeritPurchaseFull { BillId?: string; Id?: string; VendorId?: string; VendorName?: string; BillNo: string; DocDate: string; DueDate?: string; CurrencyCode?: string; }
interface MeritPaymentCreated { InvoiceId?: string; PaymentId?: string; }
