import { describe, expect, it, vi } from "vitest";
import { EarveldajaAdapter, linesToSaleItems, linesToPurchaseItems, postingToEaPosting } from "./adapter.js";
import type { ApiContext } from "../../tools/crud/shared.js";
import type { InvoiceLine, JournalEntry, Payment, PurchaseInvoice, SalesInvoice } from "../types.js";

function fakeApi(overrides: Record<string, unknown> = {}): { api: ApiContext; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    getAccounts: vi.fn(async () => [
      { id: 1360, name_est: "Pank", name_eng: "Bank", account_type_eng: "Assets", allows_dimensions: true },
    ]),
    journalsCreate: vi.fn(async () => ({ code: 200, created_object_id: 77, messages: [] })),
    saleConfirm: vi.fn(async () => ({ code: 200, messages: [] })),
    txConfirm: vi.fn(async () => ({ code: 200, messages: [] })),
    txGet: vi.fn(async () => ({ clients_id: null })),
    txUpdate: vi.fn(async () => ({ code: 200, messages: [] })),
    createAndSetTotals: vi.fn(async () => ({ id: 601 })),
  };
  const api = {
    readonly: { getAccounts: spies.getAccounts, getSaleArticles: vi.fn(async () => []) },
    clients: { listAll: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
    products: { listAll: vi.fn(async () => []) },
    journals: { create: spies.journalsCreate, confirm: vi.fn(), invalidate: vi.fn() },
    saleInvoices: { create: vi.fn(), confirm: spies.saleConfirm, invalidate: vi.fn(), listAll: vi.fn(async () => []) },
    purchaseInvoices: { create: vi.fn(), createAndSetTotals: spies.createAndSetTotals, confirm: vi.fn(), invalidate: vi.fn(), listAll: vi.fn(async () => []) },
    transactions: { confirm: spies.txConfirm, get: spies.txGet, update: spies.txUpdate, invalidate: vi.fn() },
    ...overrides,
  } as unknown as ApiContext;
  return { api, spies };
}

describe("EarveldajaAdapter capabilities", () => {
  it("declares the explicit, series-managed profile", () => {
    const { api } = fakeApi();
    const cap = new EarveldajaAdapter(api).capabilities;
    expect(cap.backendId).toBe("e-arveldaja");
    expect(cap.bookingModel).toBe("explicit");
    expect(cap.numbering).toBe("seriesManaged");
    expect(cap.refFormat).toBe("int");
    expect(cap.requiresSourceDocOnEntry).toBe(true);
  });
});

describe("EarveldajaAdapter.listAccounts", () => {
  it("maps chart of accounts to canonical refs", async () => {
    const { api } = fakeApi();
    const res = await new EarveldajaAdapter(api).listAccounts();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toMatchObject({ code: "1360", name: "Bank", type: "asset", requiresDimension: true });
    expect(res.data[0]!.id.backend).toBe("e-arveldaja");
  });
});

describe("EarveldajaAdapter.postJournal", () => {
  it("explicitly posts D/C postings via journals.create", async () => {
    const { api, spies } = fakeApi();
    const entry: JournalEntry = {
      date: "2026-01-01",
      memo: "test",
      postings: [
        { account: "1360", debit: { amount: "100", currency: "EUR" } },
        { account: "4000", credit: { amount: "100", currency: "EUR" } },
      ],
    };
    const res = await new EarveldajaAdapter(api).postJournal(entry);
    expect(res.ok).toBe(true);
    const sent = spies.journalsCreate.mock.calls[0]![0] as { postings: Array<{ type: string; accounts_id: number }> };
    expect(sent.postings).toEqual([
      { accounts_id: 1360, type: "D", amount: 100 },
      { accounts_id: 4000, type: "C", amount: 100 },
    ]);
  });
});

describe("linesToSaleItems", () => {
  it("maps canonical line fields and lets raw carry backend extras (lossless)", () => {
    const lines: InvoiceLine[] = [{
      item: { entity: "item", backend: "e-arveldaja", value: "555" },
      description: "Consulting",
      quantity: "2",
      unitPrice: { amount: "100", currency: "EUR" },
      taxCode: "",
      account: "30001",
      dimensions: [{ axis: "saleAccount", value: "777" }, { axis: "project", value: "12" }],
      raw: { cl_sale_articles_id: 9, vat_accounts_id: 41, discount_percent: 10 },
    }];
    expect(linesToSaleItems(lines)[0]).toEqual({
      products_id: 555,
      custom_title: "Consulting",
      amount: 2,
      unit_net_price: 100,
      sale_accounts_id: 30001,
      sale_accounts_dimensions_id: 777,
      projects_project_id: 12,
      cl_sale_articles_id: 9,
      vat_accounts_id: 41,
      discount_percent: 10,
    });
  });
});

describe("EarveldajaAdapter.createSalesInvoice", () => {
  it("builds the API body from canonical lines + raw and reports a draft", async () => {
    const create = vi.fn(async () => ({ code: 200, created_object_id: 501, messages: [] }));
    const { api } = fakeApi({ saleInvoices: { create, confirm: vi.fn(), invalidate: vi.fn(), listAll: vi.fn() } });
    const invoice: SalesInvoice = {
      customer: { entity: "party", backend: "e-arveldaja", value: "8" },
      docDate: "2026-05-01",
      dueDate: "2026-05-15",
      currency: "EUR",
      number: "",
      lines: [{ item: { entity: "item", backend: "e-arveldaja", value: "1" }, description: "X", quantity: "1", unitPrice: { amount: "50", currency: "EUR" }, taxCode: "", account: "30001" }],
      raw: { cl_templates_id: 3, journal_date: "2026-05-02", term_days: 14 },
    };
    const res = await new EarveldajaAdapter(api).createSalesInvoice(invoice);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id?.value).toBe("501");
    expect(res.data.status).toBe("draft"); // explicit backend: created as draft, not posted
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ clients_id: 8, cl_templates_id: 3, journal_date: "2026-05-02", create_date: "2026-05-01" });
    expect((body.items as unknown[])).toHaveLength(1);
  });
});

describe("linesToPurchaseItems", () => {
  it("maps common fields and preserves backend extras via raw", () => {
    const lines: InvoiceLine[] = [{
      item: { entity: "item", backend: "e-arveldaja", value: "5" },
      description: "Hosting",
      quantity: "1",
      unitPrice: { amount: "20", currency: "EUR" },
      taxCode: "24%",
      account: "5120",
      raw: { cl_purchase_articles_id: 7, vat_accounts_id: 41, total_net_price: 20, vat_rate_dropdown: "24%" },
    }];
    expect(linesToPurchaseItems(lines)[0]).toMatchObject({
      products_id: 5, custom_title: "Hosting", purchase_accounts_id: 5120,
      cl_purchase_articles_id: 7, vat_accounts_id: 41, total_net_price: 20,
    });
  });
});

describe("postingToEaPosting", () => {
  it("maps account/type/amount, dimensions, and raw extras", () => {
    const ea = postingToEaPosting({
      account: "1360",
      debit: { amount: "100", currency: "EUR" },
      dimensions: [{ axis: "account", value: "888" }, { axis: "project", value: "3" }],
      raw: { base_amount: 92.5 },
    });
    expect(ea).toMatchObject({ accounts_id: 1360, type: "D", amount: 100, accounts_dimensions_id: 888, projects_project_id: 3, base_amount: 92.5 });
  });
});

describe("EarveldajaAdapter.createPurchaseInvoice", () => {
  it("uses createAndSetTotals when __setTotals is set, passing vat/gross/isVatReg", async () => {
    const { api, spies } = fakeApi();
    const invoice: PurchaseInvoice = {
      vendor: { entity: "party", backend: "e-arveldaja", value: "8" },
      vendorBillNo: "INV-9",
      docDate: "2026-05-01",
      dueDate: "2026-05-15",
      currency: "EUR",
      lines: [{ description: "X", quantity: "1", unitPrice: { amount: "50", currency: "EUR" }, taxCode: "", account: "5120", raw: { cl_purchase_articles_id: 1, total_net_price: 50 } }],
      raw: { client_name: "Supplier", term_days: 14, liability_accounts_id: 2310, __setTotals: true, __vatPrice: 12, __grossPrice: 62, __isVatReg: true },
    };
    const res = await new EarveldajaAdapter(api).createPurchaseInvoice(invoice);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id?.value).toBe("601");
    const [data, vat, gross, isVatReg] = spies.createAndSetTotals.mock.calls[0]!;
    expect(vat).toBe(12);
    expect(gross).toBe(62);
    expect(isVatReg).toBe(true);
    expect(data).toMatchObject({ clients_id: 8, client_name: "Supplier", number: "INV-9", term_days: 14 });
    expect((data as { items: unknown[] }).items).toHaveLength(1);
    expect((data as Record<string, unknown>).__setTotals).toBeUndefined(); // hint keys stripped
  });
});

describe("EarveldajaAdapter.recordPayment (account distribution)", () => {
  it("maps an account-dimension allocation to related_sub_id and pre-sets clients_id", async () => {
    const { api, spies } = fakeApi();
    const payment: Payment = {
      bank: { entity: "account", backend: "e-arveldaja", value: "" },
      date: "",
      amount: { amount: "0", currency: "EUR" },
      allocations: [{ target: { account: "1360" }, amount: { amount: "50", currency: "EUR" }, dimensions: [{ axis: "account", value: "777" }] }],
      raw: { transaction_id: 42, clients_id: 9 },
    };
    const res = await new EarveldajaAdapter(api).recordPayment(payment);
    expect(res.ok).toBe(true);
    expect(spies.txUpdate).toHaveBeenCalledWith(42, { clients_id: 9 });
    expect(spies.txConfirm).toHaveBeenCalledWith(42, [
      { related_table: "accounts", related_id: 1360, related_sub_id: 777, amount: 50 },
    ]);
  });
});

describe("EarveldajaAdapter.confirm", () => {
  it("routes a sale invoice ref to saleInvoices.confirm", async () => {
    const { api, spies } = fakeApi();
    const res = await new EarveldajaAdapter(api).confirm({ entity: "salesInvoice", backend: "e-arveldaja", value: "42" });
    expect(res.ok).toBe(true);
    expect(spies.saleConfirm).toHaveBeenCalledWith(42);
  });
});

describe("EarveldajaAdapter.recordPayment", () => {
  it("confirms an imported transaction with a distribution array", async () => {
    const { api, spies } = fakeApi();
    const payment: Payment = {
      bank: { entity: "account", backend: "e-arveldaja", value: "1360" },
      date: "2026-01-01",
      amount: { amount: "59.94", currency: "EUR" },
      allocations: [{ target: { entity: "purchaseInvoice", backend: "e-arveldaja", value: "123" }, amount: { amount: "59.94", currency: "EUR" } }],
      raw: { transaction_id: 999 },
    };
    const res = await new EarveldajaAdapter(api).recordPayment(payment);
    expect(res.ok).toBe(true);
    expect(spies.txConfirm).toHaveBeenCalledWith(999, [
      { related_table: "purchase_invoices", related_id: 123, amount: 59.94 },
    ]);
  });

  it("rejects a payment with no imported transaction id", async () => {
    const { api } = fakeApi();
    const res = await new EarveldajaAdapter(api).recordPayment({
      bank: { entity: "account", backend: "e-arveldaja", value: "1360" },
      date: "2026-01-01",
      amount: { amount: "10", currency: "EUR" },
      allocations: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unsupported");
  });
});
