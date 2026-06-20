/**
 * e-arveldaja (RIK e-Financials) adapter for the LedgerConnector port.
 *
 * This is the "explicit" booking model: documents move through
 * draft → confirmed → void, and a journal lands as explicit postings. The
 * adapter wraps the existing `ApiContext` api clients so it reuses the active
 * connection's HttpClient, cache, auth and audit machinery unchanged.
 *
 * Backend-specific required fields that the canonical model cannot express
 * (cl_templates_id, sale/purchase article ids, …) are read from each
 * document's `raw` passthrough; the adapter emits a warning when it has to.
 */
import type { ApiContext } from "../../tools/crud/shared.js";
import type {
  Account, Item, JournalEntry, Party, Payment, PurchaseInvoice, Ref,
  Result, SalesInvoice, StatementSection, TaxRate, TrialBalanceRow, DocStatus,
  Money,
} from "../types.js";
import type { Capabilities, LedgerConnector, ListQuery } from "../port.js";
import { ok, fail, fromThrown } from "../result.js";
import type {
  Client, Product, Posting as EaPosting, SaleInvoice as EaSaleInvoice,
  PurchaseInvoice as EaPurchaseInvoice, TransactionDistribution, SaleInvoiceItem,
} from "../../types/api.js";
import type { InvoiceLine } from "../types.js";

const BACKEND_ID = "e-arveldaja";

function intRef<E extends string>(entity: E, value: number | string | undefined): Ref<E> {
  return { entity, backend: BACKEND_ID, value: String(value ?? "") };
}

function refToInt(ref: Ref): number {
  const n = Number(ref.value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Expected an integer e-arveldaja id, got "${ref.value}"`);
  }
  return n;
}

function money(amount: number | undefined, currency = "EUR"): Money {
  return { amount: String(amount ?? 0), currency };
}

function accountType(a: Account["type"], eng: string): Account["type"] {
  const t = eng.toLowerCase();
  if (t.includes("asset")) return "asset";
  if (t.includes("liabilit")) return "liability";
  if (t.includes("equity")) return "equity";
  if (t.includes("revenue") || t.includes("income")) return "revenue";
  if (t.includes("expense")) return "expense";
  return a;
}

export class EarveldajaAdapter implements LedgerConnector {
  readonly capabilities: Capabilities = {
    backendId: BACKEND_ID,
    label: "e-arveldaja (RIK e-Financials)",
    numbering: "seriesManaged",
    bookingModel: "explicit",
    refFormat: "int",
    dimensionModel: "namedObjects",
    vatScope: "perLine",
    requiresSourceDocOnEntry: true,
    writeTransport: "same",
    features: {
      bankImport: true,
      ocrIntake: true,
      asyncIntake: true,
      eInvoiceDelivery: true,
      taxPackages: true,
      recurringInvoices: true,
      nativePassthrough: false,
    },
  };

  constructor(private api: ApiContext) {}

  async listAccounts(): Promise<Result<Account[]>> {
    try {
      const rows = await this.api.readonly.getAccounts();
      return ok(rows.map((a) => ({
        id: intRef("account", a.id),
        code: String(a.id),
        name: a.name_eng || a.name_est,
        type: accountType("expense", a.account_type_eng),
        requiresDimension: a.allows_dimensions ?? false,
      })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listTaxRates(): Promise<Result<TaxRate[]>> {
    try {
      const articles = await this.api.readonly.getSaleArticles();
      const seen = new Map<number, TaxRate>();
      for (const art of articles) {
        if (typeof art.vat_rate === "number" && !seen.has(art.vat_rate)) {
          seen.set(art.vat_rate, { code: `VAT${art.vat_rate}`, ratePct: art.vat_rate });
        }
      }
      return ok([...seen.values()].sort((x, y) => x.ratePct - y.ratePct));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listParties(): Promise<Result<Party[]>> {
    try {
      const rows = await this.api.clients.listAll();
      return ok(rows.filter((c) => !c.is_deleted).map(toCanonicalParty));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async upsertParty(p: Party): Promise<Result<Party>> {
    try {
      const body = toEarveldajaClient(p);
      if (p.id) {
        await this.api.clients.update(refToInt(p.id), body);
        return ok({ ...p });
      }
      const res = await this.api.clients.create(body);
      return ok({ ...p, id: intRef("party", res.created_object_id) });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listItems(): Promise<Result<Item[]>> {
    try {
      const rows = await this.api.products.listAll();
      return ok(rows.filter((x: Product) => !x.is_deleted).map((x: Product) => ({
        id: intRef("item", x.id),
        code: x.code,
        name: x.name,
        unit: x.unit ?? undefined,
      })));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createSalesInvoice(inv: SalesInvoice): Promise<Result<SalesInvoice>> {
    try {
      const raw = (inv.raw ?? {}) as Partial<EaSaleInvoice>;
      const clientsId = "name" in inv.customer ? raw.clients_id : refToInt(inv.customer);
      if (clientsId == null) {
        return fail({ code: "validation", message: "e-arveldaja needs a clients_id; pass an existing customer Ref or raw.clients_id" });
      }
      // Canonical lines map to SaleInvoiceItem; raw.items is the explicit fallback.
      const items = inv.lines.length > 0 ? linesToSaleItems(inv.lines) : raw.items;
      const body: Partial<EaSaleInvoice> = {
        ...raw,
        clients_id: clientsId,
        cl_currencies_id: inv.currency,
        create_date: inv.docDate,
        journal_date: raw.journal_date ?? inv.dueDate ?? inv.docDate,
        ...(inv.number ? { number_suffix: inv.number } : {}),
        ...(items ? { items } : {}),
      };
      const res = await this.api.saleInvoices.create(body);
      return ok({ ...inv, id: intRef("salesInvoice", res.created_object_id), status: "draft", settle: "unpaid" },
        "name" in inv.customer ? [{ code: "raw_used", message: "Used raw.clients_id / template fields for e-arveldaja-specific requirements" }] : undefined);
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listSalesInvoices(q: ListQuery): Promise<Result<SalesInvoice[]>> {
    try {
      const rows = await this.api.saleInvoices.listAll(toListParams(q));
      return ok(rows.map(toCanonicalSaleInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  async createPurchaseInvoice(inv: PurchaseInvoice): Promise<Result<PurchaseInvoice>> {
    try {
      const raw = (inv.raw ?? {}) as Partial<EaPurchaseInvoice>;
      const clientsId = "name" in inv.vendor ? raw.clients_id : refToInt(inv.vendor);
      if (clientsId == null) {
        return fail({ code: "validation", message: "e-arveldaja needs a clients_id; pass an existing vendor Ref or raw.clients_id" });
      }
      const body: Partial<EaPurchaseInvoice> = {
        ...raw,
        clients_id: clientsId,
        client_name: "name" in inv.vendor ? inv.vendor.name : (raw.client_name ?? ""),
        number: inv.vendorBillNo,
        cl_currencies_id: inv.currency,
        create_date: inv.docDate,
        journal_date: inv.docDate,
      };
      const res = await this.api.purchaseInvoices.create(body);
      return ok({ ...inv, id: intRef("purchaseInvoice", res.created_object_id), status: "draft", settle: "unpaid" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async listPurchaseInvoices(q: ListQuery): Promise<Result<PurchaseInvoice[]>> {
    try {
      const rows = await this.api.purchaseInvoices.listAll(toListParams(q));
      return ok(rows.map(toCanonicalPurchaseInvoice));
    } catch (e) { return fail(fromThrown(e)); }
  }

  /**
   * On e-arveldaja a payment is a bank transaction confirmed against its
   * targets. The transaction must already exist (imported via CAMT/Wise); the
   * canonical Payment.raw must carry its transaction id. The allocations become
   * the distribution array.
   */
  async recordPayment(p: Payment): Promise<Result<Payment>> {
    try {
      const transactionId = Number((p.raw as { transaction_id?: number } | undefined)?.transaction_id);
      if (!Number.isInteger(transactionId) || transactionId <= 0) {
        return fail({ code: "unsupported", message: "e-arveldaja settles by confirming an imported bank transaction; pass raw.transaction_id" });
      }
      const distributions: TransactionDistribution[] = p.allocations.map((a) => {
        if ("account" in a.target) {
          return { related_table: "accounts", related_id: Number(a.target.account), amount: Number(a.amount.amount) };
        }
        const table = a.target.entity === "salesInvoice" ? "sale_invoices" : "purchase_invoices";
        return { related_table: table, related_id: refToInt(a.target), amount: Number(a.amount.amount) };
      });
      await this.api.transactions.confirm(transactionId, distributions);
      return ok({ ...p, id: intRef("payment", transactionId), status: "confirmed" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  /** Explicit booking: postings land as a registered journal. */
  async postJournal(entry: JournalEntry): Promise<Result<JournalEntry>> {
    try {
      const postings: EaPosting[] = entry.postings.map((p) => ({
        accounts_id: Number(p.account),
        type: p.debit ? "D" : "C",
        amount: Number((p.debit ?? p.credit)?.amount ?? 0),
      }));
      const res = await this.api.journals.create({
        effective_date: entry.date,
        title: entry.memo,
        document_number: entry.docNo,
        postings,
      });
      return ok({ ...entry, id: intRef("journal", res.created_object_id), status: "draft" });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async confirm(id: Ref): Promise<Result<{ status: DocStatus }>> {
    try {
      const n = refToInt(id);
      if (id.entity === "salesInvoice") await this.api.saleInvoices.confirm(n);
      else if (id.entity === "purchaseInvoice") await this.api.purchaseInvoices.confirm(n);
      else if (id.entity === "journal") await this.api.journals.confirm(n);
      else if (id.entity === "payment") await this.api.transactions.confirm(n);
      else return fail({ code: "unsupported", message: `confirm not supported for ${id.entity}` });
      return ok({ status: "confirmed" as DocStatus });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async void(id: Ref): Promise<Result<{ status: DocStatus }>> {
    try {
      const n = refToInt(id);
      if (id.entity === "salesInvoice") await this.api.saleInvoices.invalidate(n);
      else if (id.entity === "purchaseInvoice") await this.api.purchaseInvoices.invalidate(n);
      else if (id.entity === "journal") await this.api.journals.invalidate(n);
      else if (id.entity === "payment") await this.api.transactions.invalidate(n);
      else return fail({ code: "unsupported", message: `void not supported for ${id.entity}` });
      return ok({ status: "void" as DocStatus });
    } catch (e) { return fail(fromThrown(e)); }
  }

  async trialBalance(): Promise<Result<TrialBalanceRow[]>> {
    return fail({ code: "unsupported", message: "Use the existing trial_balance tool; not yet exposed through the ledger port." });
  }

  async incomeStatement(): Promise<Result<StatementSection[]>> {
    return fail({ code: "unsupported", message: "Use the existing income_statement tool; not yet exposed through the ledger port." });
  }
}

function toListParams(q: ListQuery): { start_date?: string; end_date?: string } {
  return {
    ...(q.periodStart ? { start_date: q.periodStart } : {}),
    ...(q.periodEnd ? { end_date: q.periodEnd } : {}),
  };
}

/** Map a canonical cost dimension onto e-arveldaja sale-item dimension fields. */
function saleLineDimensions(dims?: InvoiceLine["dimensions"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dims ?? []) {
    const v = Number(typeof d.value === "string" ? d.value : d.value.value);
    if (!Number.isFinite(v)) continue;
    if (d.axis === "saleAccount") out.sale_accounts_dimensions_id = v;
    else if (d.axis === "project") out.projects_project_id = v;
    else if (d.axis === "location") out.projects_location_id = v;
    else if (d.axis === "reportingPerson") out.projects_person_id = v;
  }
  return out;
}

/**
 * Map canonical invoice lines to e-arveldaja SaleInvoiceItem rows. The common
 * fields come from the canonical shape; backend-specific extras (sale article,
 * VAT account, discount, …) ride through each line's `raw`.
 */
export function linesToSaleItems(lines: InvoiceLine[]): SaleInvoiceItem[] {
  return lines.map((l) => {
    const productsId = l.item && "value" in l.item ? Number(l.item.value) : undefined;
    const base: Partial<SaleInvoiceItem> = {
      ...(productsId != null ? { products_id: productsId } : {}),
      custom_title: l.description ?? (l.item && "name" in l.item ? l.item.name : "") ?? "",
      amount: Number(l.quantity),
      unit_net_price: Number(l.unitPrice.amount),
      ...(l.account ? { sale_accounts_id: Number(l.account) } : {}),
      ...saleLineDimensions(l.dimensions),
    };
    return { ...base, ...(l.raw ?? {}) } as SaleInvoiceItem;
  });
}

function toCanonicalParty(c: Client): Party {
  const kind: Party["kind"] = c.is_client && c.is_supplier ? "both" : c.is_supplier ? "vendor" : "customer";
  return {
    id: intRef("party", c.id),
    kind,
    name: c.name,
    regCode: c.code ?? undefined,
    vatNumber: c.invoice_vat_no ?? undefined,
    email: c.email ?? undefined,
    iban: c.bank_account_no ?? undefined,
  };
}

function toEarveldajaClient(p: Party): Partial<Client> {
  const base: Partial<Client> = {
    is_client: p.kind === "customer" || p.kind === "both",
    is_supplier: p.kind === "vendor" || p.kind === "both",
    name: p.name,
    code: p.regCode ?? null,
    invoice_vat_no: p.vatNumber ?? null,
    email: p.email ?? null,
    bank_account_no: p.iban ?? null,
    cl_code_country: "EE",
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
  };
  // raw is the documented escape hatch for backend-specific required fields.
  return { ...base, ...(p.raw ?? {}) } as Partial<Client>;
}

function statusToDoc(status?: string): DocStatus {
  if (status === "CONFIRMED") return "confirmed";
  if (status === "VOID") return "void";
  return "draft";
}

function settleStatus(payment_status?: string): SalesInvoice["settle"] {
  if (payment_status === "PAID") return "paid";
  if (payment_status === "PARTIALLY_PAID") return "partial";
  return "unpaid";
}

function toCanonicalSaleInvoice(r: EaSaleInvoice): SalesInvoice {
  return {
    id: intRef("salesInvoice", r.id),
    status: statusToDoc(r.status),
    settle: settleStatus(r.payment_status),
    number: r.number ?? undefined,
    customer: intRef("party", r.clients_id),
    docDate: r.create_date,
    dueDate: r.journal_date,
    currency: r.cl_currencies_id,
    lines: [],
    total: money(r.gross_price, r.cl_currencies_id),
  };
}

function toCanonicalPurchaseInvoice(r: EaPurchaseInvoice): PurchaseInvoice {
  return {
    id: intRef("purchaseInvoice", r.id),
    status: statusToDoc(r.status),
    settle: settleStatus(r.payment_status),
    vendor: intRef("party", r.clients_id),
    vendorBillNo: r.number,
    docDate: r.create_date,
    dueDate: r.journal_date,
    currency: r.cl_currencies_id,
    lines: [],
    total: money(r.gross_price, r.cl_currencies_id),
  };
}
