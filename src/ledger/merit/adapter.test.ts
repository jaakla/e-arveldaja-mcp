import { describe, expect, it } from "vitest";
import { MeritAdapter, isBalanced, toMeritSalesInvoice, toMeritEntryRow } from "./adapter.js";
import type { MeritHttp } from "./http.js";
import type { JournalEntry, SalesInvoice } from "../types.js";

interface Call { endpoint: string; body?: unknown; version?: string }

function fakeHttp(responder: (endpoint: string) => unknown): { http: MeritHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: MeritHttp = {
    async post<T>(endpoint: string, body?: unknown, opts?: { version?: "v1" | "v2" }): Promise<T> {
      calls.push({ endpoint, body, version: opts?.version });
      return responder(endpoint) as T;
    },
  };
  return { http, calls };
}

const eur = (n: string) => ({ amount: n, currency: "EUR" });

describe("MeritAdapter capabilities", () => {
  it("declares the auto-post, caller-assigned profile", () => {
    const { http } = fakeHttp(() => []);
    const cap = new MeritAdapter(http).capabilities;
    expect(cap.backendId).toBe("merit");
    expect(cap.bookingModel).toBe("autoPost");
    expect(cap.numbering).toBe("callerAssigned");
    expect(cap.refFormat).toBe("guid");
    expect(cap.maxQuerySpanDays).toBe(92);
  });
});

describe("MeritAdapter.listAccounts", () => {
  it("maps the real getaccounts fields (AccountID, not Id) and filters inactive rows", async () => {
    // Field names verified against the live Merit v1 getaccounts response.
    const { http } = fakeHttp(() => [
      { AccountID: "0e8abc3d-9cb3-4b2e-beb6-004efc5ab279", Code: "1632", Name: "Aktsiafondid", NonActive: "False", IsParent: "Detailne" },
      { AccountID: "aaaaaaaa-0000-0000-0000-000000000001", Code: "9999", Name: "Vana konto", NonActive: "True" },
    ]);
    const res = await new MeritAdapter(http).listAccounts();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1); // inactive row filtered
    expect(res.data[0]!).toEqual({
      id: { entity: "account", backend: "merit", value: "0e8abc3d-9cb3-4b2e-beb6-004efc5ab279" },
      code: "1632",
      name: "Aktsiafondid",
    });
    // Merit exposes no account type / dimension flags — must be omitted, not guessed.
    expect(res.data[0]!).not.toHaveProperty("type");
    expect(res.data[0]!).not.toHaveProperty("requiresDimension");
  });
});

describe("MeritAdapter.createSalesInvoice", () => {
  it("auto-fills the next number, maps tax code to GUID, and posts immediately", async () => {
    const { http, calls } = fakeHttp((endpoint) => {
      if (endpoint === "gettaxes") return [{ Id: "TAX-GUID", Code: "STD24", Name: "24%", TaxPct: 24 }];
      if (endpoint === "getinvoices") return [{ InvoiceId: "x", InvoiceNo: "1008", DocDate: "20260101" }];
      if (endpoint === "sendinvoice") return { InvoiceId: "INV-1", InvoiceNo: "1008" };
      return [];
    });
    const adapter = new MeritAdapter(http);
    const invoice: SalesInvoice = {
      customer: { name: "Acme OÜ", regCode: "12345678" },
      docDate: "2026-04-15",
      dueDate: "2026-04-29",
      currency: "EUR",
      lines: [{ quantity: "1", unitPrice: eur("100.00"), taxCode: "STD24", account: "30001", description: "Consulting" }],
    };
    const res = await adapter.createSalesInvoice(invoice);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id?.value).toBe("INV-1");
    expect(res.data.status).toBe("confirmed"); // posted on create, not a draft
    const sent = calls.find((c) => c.endpoint === "sendinvoice")!.body as Record<string, unknown>;
    expect(sent.InvoiceNo).toBe("1009"); // 1008 + 1
    const rows = sent.InvoiceRow as Array<Record<string, unknown>>;
    expect(rows[0]!.TaxId).toBe("TAX-GUID");
    expect(sent.DocDate).toBe("20260415"); // YYYYMMDD
    // Merit requires REAL VAT amounts and a gross total (100 net + 24% VAT).
    expect(sent.TaxAmount).toEqual([{ TaxId: "TAX-GUID", Amount: 24 }]);
    expect(sent.TotalAmount).toBe(124);
    // The number lookup must stay inside Merit's ~3-month query cap.
    const lookup = calls.find((c) => c.endpoint === "getinvoices")!.body as Record<string, unknown>;
    expect(lookup.PeriodStart).toBe("20260115"); // docDate - 90d
    expect(lookup.PeriodEnd).toBe("20260415");
  });
});

describe("MeritAdapter.createPurchaseInvoice", () => {
  const taxes = [{ Id: "TAX-GUID", Code: "STD24", Name: "24%", TaxPct: 24 }];

  it("sends the reference-verified payload: InvoiceRow, GLAccountCode, TaxAmount, gross total, BillId response", async () => {
    const { http, calls } = fakeHttp((endpoint) => {
      if (endpoint === "gettaxes") return taxes;
      if (endpoint === "sendpurchinvoice") return { BillId: "BILL-1", BillNo: "INV-9" };
      return [];
    });
    const res = await new MeritAdapter(http).createPurchaseInvoice({
      vendor: { name: "Tarnija OÜ", regCode: "87654321" },
      vendorBillNo: "INV-9",
      docDate: "2026-04-15",
      dueDate: "2026-04-29",
      currency: "EUR",
      lines: [{ quantity: "1", unitPrice: eur("100.00"), taxCode: "STD24", account: "4017", description: "Teenus" }],
      sourceDocument: { filename: "arve.pdf", mimeType: "application/pdf", contentBase64: "QUJD" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id?.value).toBe("BILL-1");
    const sent = calls.find((c) => c.endpoint === "sendpurchinvoice")!.body as Record<string, unknown>;
    expect(sent.InvoiceRow).toBeDefined(); // NOT PurchaseInvoiceRow
    expect(sent).not.toHaveProperty("PurchaseInvoiceRow");
    const row = (sent.InvoiceRow as Array<Record<string, unknown>>)[0]!;
    expect(row.GLAccountCode).toBe("4017"); // purchase rows use GLAccountCode
    expect(row).not.toHaveProperty("Account");
    expect((row.Item as Record<string, unknown>).TaxId).toBe("TAX-GUID");
    expect(sent.TransactionDate).toBe("20260415");
    expect(sent.CurrencyRate).toBe(1.0);
    expect(sent.TaxAmount).toEqual([{ TaxId: "TAX-GUID", Amount: 24 }]);
    expect(sent.TotalAmount).toBe(124);
    expect(sent.RoundingAmount).toBe(0);
    expect((sent.Attachment as Record<string, unknown>).FileName).toBe("arve.pdf");
  });

  it("resolves a Ref vendor to {Id, Name} via the vendor registry (Merit requires both)", async () => {
    const { http, calls } = fakeHttp((endpoint) => {
      if (endpoint === "gettaxes") return taxes;
      if (endpoint === "getvendors") return [{ VendorId: "VEN-1", Name: "Tarnija OÜ" }];
      if (endpoint === "sendpurchinvoice") return { BillId: "BILL-2" };
      return [];
    });
    const res = await new MeritAdapter(http).createPurchaseInvoice({
      vendor: { entity: "party", backend: "merit", value: "VEN-1" },
      vendorBillNo: "INV-10", docDate: "2026-04-15", dueDate: "2026-04-29", currency: "EUR",
      lines: [{ quantity: "1", unitPrice: eur("10"), taxCode: "STD24", account: "4017" }],
    });
    expect(res.ok).toBe(true);
    const sent = calls.find((c) => c.endpoint === "sendpurchinvoice")!.body as Record<string, unknown>;
    expect(sent.Vendor).toEqual({ Id: "VEN-1", Name: "Tarnija OÜ" });
  });

  it("fails with not_found when a Ref vendor is not in the registry", async () => {
    const { http } = fakeHttp((endpoint) => (endpoint === "getvendors" ? [] : []));
    const res = await new MeritAdapter(http).createPurchaseInvoice({
      vendor: { entity: "party", backend: "merit", value: "MISSING" },
      vendorBillNo: "X", docDate: "2026-04-15", dueDate: "2026-04-29", currency: "EUR", lines: [],
    });
    expect(!res.ok && res.error.code).toBe("not_found");
  });
});

describe("MeritAdapter.recordPayment", () => {
  it("resolves BillNo/VendorName from the invoice and IBAN from the vendor, then sends the flat payload", async () => {
    const { http, calls } = fakeHttp((endpoint) => {
      if (endpoint === "getpurchorder") return { BillId: "BILL-1", BillNo: "INV-9", VendorName: "Tarnija OÜ" };
      if (endpoint === "getvendors") return [{ VendorId: "VEN-1", Name: "Tarnija OÜ", BankAccount: "EE001234" }];
      if (endpoint === "sendPaymentV") return { InvoiceId: "PAY-1" };
      return [];
    });
    const res = await new MeritAdapter(http).recordPayment({
      bank: { entity: "account", backend: "merit", value: "BANK-1" },
      date: "2026-04-30",
      amount: eur("124.00"),
      allocations: [{ target: { entity: "purchaseInvoice", backend: "merit", value: "BILL-1" }, amount: eur("124.00") }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.id?.value).toBe("PAY-1"); // response field is InvoiceId
    const call = calls.find((c) => c.endpoint === "sendPaymentV")!;
    expect(call.version).toBe("v1"); // EUR → v1
    expect(call.body).toMatchObject({
      BankId: "BANK-1", VendorName: "Tarnija OÜ", BillNo: "INV-9",
      Amount: 124, IBAN: "EE001234", PaymentDate: "20260430",
    });
    expect(call.body).not.toHaveProperty("PaymentRow");
  });

  it("fails validation when the vendor has no IBAN and none was passed", async () => {
    const { http } = fakeHttp((endpoint) => {
      if (endpoint === "getpurchorder") return { BillNo: "INV-9", VendorName: "Tarnija OÜ" };
      if (endpoint === "getvendors") return [{ VendorId: "VEN-1", Name: "Tarnija OÜ" }]; // no BankAccount
      return [];
    });
    const res = await new MeritAdapter(http).recordPayment({
      bank: { entity: "account", backend: "merit", value: "" },
      date: "2026-04-30", amount: eur("10"),
      allocations: [{ target: { entity: "purchaseInvoice", backend: "merit", value: "BILL-1" }, amount: eur("10") }],
    });
    expect(!res.ok && res.error.code).toBe("validation");
  });

  it("rejects multi-allocation payments (one bill per sendPaymentV call)", async () => {
    const { http, calls } = fakeHttp(() => []);
    const alloc = { target: { entity: "purchaseInvoice", backend: "merit", value: "B" } as const, amount: eur("5") };
    const res = await new MeritAdapter(http).recordPayment({
      bank: { entity: "account", backend: "merit", value: "" },
      date: "2026-04-30", amount: eur("10"), allocations: [alloc, alloc],
    });
    expect(!res.ok && res.error.code).toBe("validation");
    expect(calls).toHaveLength(0);
  });
});

describe("MeritAdapter parties and items", () => {
  it("listParties merges the customer and vendor registries with the right kinds", async () => {
    const { http, calls } = fakeHttp((endpoint) => {
      if (endpoint === "getcustomers") return [{ CustomerId: "C1", Name: "Klient OÜ" }];
      if (endpoint === "getvendors") return [{ VendorId: "V1", Name: "Tarnija OÜ", BankAccount: "EE009", Email: "t@t.ee" }];
      return [];
    });
    const res = await new MeritAdapter(http).listParties();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({ kind: "customer", name: "Klient OÜ" });
    expect(res.data[1]).toMatchObject({ kind: "vendor", name: "Tarnija OÜ", iban: "EE009", email: "t@t.ee" });
    // Reads use v1 (reference-client default), not v2.
    expect(calls.every((c) => c.version === undefined)).toBe(true);
  });

  it("upsertParty routes vendors to sendvendor and customers to sendcustomer v2", async () => {
    const { http, calls } = fakeHttp((endpoint) =>
      endpoint === "sendvendor" ? { VendorId: "V-NEW" } : { CustomerId: "C-NEW" });
    const adapter = new MeritAdapter(http);

    const vendor = await adapter.upsertParty({ kind: "vendor", name: "Uus Tarnija", iban: "EE555" });
    expect(vendor.ok && vendor.data.id?.value).toBe("V-NEW");
    const vcall = calls.find((c) => c.endpoint === "sendvendor")!;
    expect(vcall.version).toBe("v1");
    expect(vcall.body).toMatchObject({ Name: "Uus Tarnija", BankAccount: "EE555" });

    const customer = await adapter.upsertParty({ kind: "customer", name: "Uus Klient" });
    expect(customer.ok && customer.data.id?.value).toBe("C-NEW");
    expect(calls.find((c) => c.endpoint === "sendcustomer")!.version).toBe("v2");
  });

  it("listItems maps v1 fields (Name, UnitofMeasureName)", async () => {
    const { http, calls } = fakeHttp(() => [{ ItemId: "I1", Code: "SVC01", Name: "Konsultatsioon", UnitofMeasureName: "tk" }]);
    const res = await new MeritAdapter(http).listItems();
    expect(res.ok && res.data[0]).toMatchObject({ code: "SVC01", name: "Konsultatsioon", unit: "tk" });
    expect(calls[0]!.version).toBeUndefined(); // v1
  });
});

describe("MeritAdapter.postJournal", () => {
  it("rejects an unbalanced entry without calling the API", async () => {
    const { http, calls } = fakeHttp(() => ({ BatchId: "B1" }));
    const entry: JournalEntry = {
      date: "2026-01-01",
      postings: [{ account: "1000", debit: eur("100") }, { account: "2000", credit: eur("90") }],
    };
    const res = await new MeritAdapter(http).postJournal(entry);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(calls).toHaveLength(0);
  });

  it("posts a balanced entry as a GL batch", async () => {
    const { http, calls } = fakeHttp(() => ({ BatchId: "B1" }));
    const entry: JournalEntry = {
      date: "2026-01-01",
      postings: [{ account: "1000", debit: eur("100") }, { account: "2000", credit: eur("100") }],
    };
    const res = await new MeritAdapter(http).postJournal(entry);
    expect(res.ok).toBe(true);
    expect(calls[0]!.endpoint).toBe("sendglbatch");
  });
});

describe("MeritAdapter.confirm", () => {
  it("is a no-op that reports confirmed (auto-post backend)", async () => {
    const { http, calls } = fakeHttp(() => ({}));
    const res = await new MeritAdapter(http).confirm();
    expect(res.ok && res.data.status).toBe("confirmed");
    expect(calls).toHaveLength(0);
  });
});

describe("pure mappers", () => {
  it("isBalanced tolerates sub-cent rounding", () => {
    expect(isBalanced([{ account: "1", debit: eur("100.001") }, { account: "2", credit: eur("100.00") }])).toBe(true);
    expect(isBalanced([{ account: "1", debit: eur("100") }, { account: "2", credit: eur("99") }])).toBe(false);
  });

  it("toMeritEntryRow fans dimensions into Merit code fields", () => {
    const row = toMeritEntryRow({ account: "5120", debit: eur("10"), dimensions: [{ axis: "project", value: "P1" }, { axis: "costCenter", value: "CC2" }] });
    expect(row).toMatchObject({ AccountCode: "5120", Debit: 10, ProjectCode: "P1", CostCenterCode: "CC2" });
  });

  it("toMeritSalesInvoice uses singular InvoiceRow, a Ref customer id, real VAT and gross total", () => {
    const body = toMeritSalesInvoice(
      { customer: { entity: "party", backend: "merit", value: "CUST-1" }, docDate: "2026-01-02", dueDate: "2026-01-16", currency: "EUR", lines: [{ quantity: "2", unitPrice: eur("50"), taxCode: "STD24", account: "30001" }] },
      "5",
      new Map([["STD24", { id: "TAX-1", pct: 24 }]]),
    );
    expect((body.Customer as Record<string, unknown>).Id).toBe("CUST-1");
    expect(Array.isArray(body.InvoiceRow)).toBe(true);
    expect(body.TaxAmount).toEqual([{ TaxId: "TAX-1", Amount: 24 }]);
    expect(body.TotalAmount).toBe(124); // gross: 100 net + 24 VAT
  });

  it("spreads canonical raw into the payload last so backend-specific fields can override", () => {
    const body = toMeritSalesInvoice(
      {
        customer: { entity: "party", backend: "merit", value: "CUST-1" },
        docDate: "2026-01-02", dueDate: "2026-01-16", currency: "EUR",
        lines: [{ quantity: "1", unitPrice: eur("10"), taxCode: "STD24", account: "30001", raw: { DiscountPct: 5 } }],
        raw: { PriceInclVat: true, TransactionDate: "20260103" },
      },
      "5",
      new Map([["STD24", { id: "TAX-1", pct: 24 }]]),
    );
    expect(body.PriceInclVat).toBe(true); // raw override wins
    expect(body.TransactionDate).toBe("20260103");
    expect((body.InvoiceRow as Array<Record<string, unknown>>)[0]!.DiscountPct).toBe(5);
  });
});
