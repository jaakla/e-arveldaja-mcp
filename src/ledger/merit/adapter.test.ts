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

  it("toMeritSalesInvoice uses singular InvoiceRow and a Ref customer id", () => {
    const body = toMeritSalesInvoice(
      { customer: { entity: "party", backend: "merit", value: "CUST-1" }, docDate: "2026-01-02", dueDate: "2026-01-16", currency: "EUR", lines: [{ quantity: "2", unitPrice: eur("50"), taxCode: "STD24", account: "30001" }] },
      "5",
      new Map([["STD24", "TAX-1"]]),
    );
    expect((body.Customer as Record<string, unknown>).Id).toBe("CUST-1");
    expect(Array.isArray(body.InvoiceRow)).toBe(true);
    expect(body.TotalAmount).toBe(100);
  });
});
