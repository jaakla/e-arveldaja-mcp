/**
 * End-to-end tests for the 15 workflow-prompt use cases against a LIVE Merit
 * Aktiva company, running the real MCP server in a Merit-only ledger session.
 *
 * Gating:
 *  - The whole suite runs only when MERIT_API_ID / MERIT_API_KEY are set
 *    (point them at a Merit DEMO company).
 *  - The mutating cases additionally require MERIT_E2E_WRITE=1. They create
 *    clearly-marked test records (names/BillNos prefixed E2E, amounts 0.01 EUR)
 *    and clean up what the port can delete (the sales invoice is voided);
 *    the test vendor, purchase invoice, payment, and GL batch remain in the
 *    demo company by design — Merit exposes no delete for them.
 *
 *   MERIT_API_ID=… MERIT_API_KEY=… MERIT_E2E_WRITE=1 npm run test:integration
 */
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseMcpResponse } from "../mcp-json.js";
import { getMeritConfig } from "../ledger/merit/config.js";
import { MeritHttpClient } from "../ledger/merit/http.js";

const meritConfig = getMeritConfig();
const RUN = meritConfig ? describe : describe.skip;
const RUN_WRITES = meritConfig && process.env.MERIT_E2E_WRITE === "1" ? describe : describe.skip;

const DIST_ENTRYPOINT = join(process.cwd(), "dist", "index.js");
const RUN_KEY = `E2E-${Date.now()}`;
const TEST_VENDOR_NAME = "E2E-MCP Test Vendor OÜ";
const TEST_VENDOR_IBAN = "EE382200221020145685";

interface LedgerResult<T = unknown> { ok: boolean; data?: T; error?: { code: string; message: string } }

let client: Client;
let transport: StdioClientTransport;
let serverCwd: string;

async function callLedger<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<LedgerResult<T>> {
  const res = await client.callTool({ name, arguments: args });
  const payload = parseMcpResponse((res.content as Array<{ text: string }>)[0]!.text) as LedgerResult<T>;
  return payload;
}

async function promptText(name: string, args?: Record<string, string>): Promise<string> {
  const res = await client.getPrompt({ name, arguments: args ?? {} });
  return (res.messages[0]!.content as { text: string }).text;
}

RUN("Merit E2E use cases (live, ledger session)", () => {
  beforeAll(async () => {
    serverCwd = mkdtempSync(join(tmpdir(), "merit-e2e-"));
    transport = new StdioClientTransport({
      command: "node",
      args: [DIST_ENTRYPOINT],
      cwd: serverCwd,
      env: {
        ...getDefaultEnvironment(),
        // Merit-only ledger session: no e-arveldaja credentials at all.
        EARVELDAJA_API_KEY_ID: "",
        EARVELDAJA_API_PUBLIC_VALUE: "",
        EARVELDAJA_API_PASSWORD: "",
        EARVELDAJA_API_KEY_FILE: "",
        EARVELDAJA_CONFIG_DIR: join(serverCwd, "global"),
        MERIT_API_ID: process.env.MERIT_API_ID!,
        MERIT_API_KEY: process.env.MERIT_API_KEY!,
        MERIT_API_COUNTRY: process.env.MERIT_API_COUNTRY ?? "EE",
      },
    });
    client = new Client({ name: "merit-e2e", version: "1.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try { await client.close(); } catch { /* already closed */ }
    await rm(serverCwd, { recursive: true, force: true });
  });

  // ---- Use cases 1–2: setup prompts declare their scope --------------------

  it("UC1 setup-credentials: runbook declares e-arveldaja-only scope with Merit pointer", async () => {
    const text = await promptText("setup-credentials");
    expect(text).toContain("Scope: e-arveldaja credentials only");
    expect(text).toContain("MERIT_API_ID");
  });

  it("UC2 setup-e-arveldaja: runbook explains the ledger session", async () => {
    const text = await promptText("setup-e-arveldaja");
    expect(text).toContain("ledger session");
    expect(text).toContain("list_ledger_backends");
  });

  // ---- Use cases 3–15: every workflow prompt serves its runbook with the
  // ---- right backend guidance in a Merit-only session ----------------------

  const PROMPT_MARKERS: Array<[name: string, args: Record<string, string> | undefined, marker: string]> = [
    ["accounting-inbox", undefined, "Backend routing"],
    ["resolve-accounting-review", { review_item_json: "{}" }, "Backend routing"],
    ["prepare-accounting-review-action", { review_item_json: "{}" }, "Backend routing"],
    ["book-invoice", { file_path: "/tmp/x.pdf" }, "Ledger branch"],
    ["receipt-batch", { folder_path: "/tmp" }, "Ledger branch"],
    ["import-camt", { file_path: "/tmp/x.xml" }, "Ledger branch"],
    ["import-wise", { file_path: "/tmp/x.csv" }, "Ledger branch"],
    ["classify-unmatched", undefined, "Ledger branch"],
    ["reconcile-bank", undefined, "Ledger branch"],
    ["month-end-close", { month: "2026-06" }, "Ledger branch"],
    ["new-supplier", { identifier: "E2E Test" }, "Ledger branch"],
    ["company-overview", undefined, "Ledger branch"],
    // Numeric args go over the wire as strings (MCP spec) — the schema coerces.
    ["lightyear-booking", { statement_path: "/tmp/x.csv", investment_account: "1550", broker_account: "1120" }, "Ledger branch"],
  ];

  it("UC3–15 prompts: all workflow runbooks are served (not setup-gated) with backend guidance", async () => {
    for (const [name, args, marker] of PROMPT_MARKERS) {
      const text = await promptText(name, args);
      expect(text, `${name} should serve its runbook`).not.toMatch(/^The server is currently running in setup mode/);
      expect(text, `${name} should carry "${marker}"`).toContain(marker);
    }
  }, 60_000);

  // ---- Local pipeline stays available inside the ledger session ------------

  it("UC-inbox: accounting_inbox scan mode runs locally in the ledger session", async () => {
    const res = await client.callTool({ name: "accounting_inbox", arguments: { mode: "scan", workspace_path: serverCwd } });
    expect(res.isError).toBeFalsy();
  }, 30_000);

  // ---- Read half of the ledger branches (live Merit) -----------------------

  it("UC-company-overview/reconcile/month-end reads: invoices list live with settle status", async () => {
    const sales = await callLedger<Array<{ settle?: string }>>("ledger_list_sales_invoices", { backend: "merit" });
    expect(sales.ok).toBe(true);
    const purchases = await callLedger<Array<{ vendorBillNo?: string; settle?: string }>>("ledger_list_purchase_invoices", { backend: "merit" });
    expect(purchases.ok).toBe(true);
    // month-end window form
    const monthWindow = await callLedger("ledger_list_purchase_invoices", {
      backend: "merit", period_start: "2026-06-01", period_end: "2026-06-30",
    });
    expect(monthWindow.ok).toBe(true);
  }, 60_000);

  it("UC-book-invoice reads: accounts and tax rates resolve live", async () => {
    const accounts = await callLedger<Array<{ code: string }>>("ledger_list_accounts", { backend: "merit" });
    expect(accounts.ok).toBe(true);
    expect(accounts.data!.length).toBeGreaterThan(0);
    const taxes = await callLedger<Array<{ code: string; ratePct: number }>>("ledger_list_tax_rates", { backend: "merit" });
    expect(taxes.ok).toBe(true);
    expect(taxes.data!.some((t) => t.ratePct === 24)).toBe(true);
  }, 60_000);

  // ---- Write cycle (opt-in): new-supplier → book-invoice → import-camt/
  // ---- reconcile-bank settlement → lightyear-booking journal → void --------

  RUN_WRITES("write cycle (MERIT_E2E_WRITE=1)", () => {
    let vendorRef: { entity: string; backend: string; value: string } | undefined;
    let invoiceRef: { entity: string; backend: string; value: string } | undefined;
    let expenseAccount: string;
    let taxCode: string;
    let itemCode: string;

    it("UC-new-supplier: ledger_upsert_party creates (or finds) the marked test vendor", async () => {
      const parties = await callLedger<Array<{ id: { value: string }; kind: string; name: string }>>(
        "ledger_list_parties", { backend: "merit" });
      expect(parties.ok).toBe(true);
      const existing = parties.data!.find((p) => p.kind === "vendor" && p.name === TEST_VENDOR_NAME);
      if (existing) {
        vendorRef = { entity: "party", backend: "merit", value: existing.id.value };
        return;
      }
      const created = await callLedger<{ id: { value: string } }>("ledger_upsert_party", {
        backend: "merit",
        party: { kind: "vendor", name: TEST_VENDOR_NAME, iban: TEST_VENDOR_IBAN, email: "e2e@example.test" },
      });
      expect(created.ok, JSON.stringify(created.error ?? {})).toBe(true);
      expect(created.data!.id.value.length).toBeGreaterThan(0);
      vendorRef = { entity: "party", backend: "merit", value: created.data!.id.value };
    }, 60_000);

    it("UC-book-invoice: ledger_create_purchase_invoice books a marked 0.01 EUR invoice", async () => {
      const accounts = await callLedger<Array<{ code: string }>>("ledger_list_accounts", { backend: "merit" });
      // Estonian chart convention: 4xxx/5xxx are expense ranges; fall back to any.
      expenseAccount = (accounts.data!.find((a) => /^[45]/.test(a.code)) ?? accounts.data![0]!).code;
      const taxes = await callLedger<Array<{ code: string; ratePct: number }>>("ledger_list_tax_rates", { backend: "merit" });
      taxCode = taxes.data!.find((t) => t.ratePct === 24)!.code;
      // Merit requires an item code on every invoice row — use a real one.
      const items = await callLedger<Array<{ code?: string; name: string }>>("ledger_list_items", { backend: "merit" });
      itemCode = items.data!.find((i) => i.code)!.code!;

      const created = await callLedger<{ id: { value: string } }>("ledger_create_purchase_invoice", {
        backend: "merit",
        invoice: {
          vendor: vendorRef,
          vendorBillNo: `${RUN_KEY}-BILL`,
          docDate: new Date().toISOString().slice(0, 10),
          dueDate: new Date().toISOString().slice(0, 10),
          currency: "EUR",
          lines: [{
            item: { code: itemCode, name: "E2E test item" },
            description: "E2E test line (safe to delete)",
            quantity: "1",
            unitPrice: { amount: "0.01", currency: "EUR" },
            taxCode,
            account: expenseAccount,
          }],
        },
      });
      expect(created.ok, JSON.stringify(created.error ?? {})).toBe(true);
      expect(created.data!.id.value.length).toBeGreaterThan(0);
      invoiceRef = { entity: "purchaseInvoice", backend: "merit", value: created.data!.id.value };

      // Read-back proves the BillId mapping end-to-end.
      const list = await callLedger<Array<{ vendorBillNo: string; id: { value: string } }>>(
        "ledger_list_purchase_invoices", { backend: "merit" });
      const found = list.data!.find((r) => r.vendorBillNo === `${RUN_KEY}-BILL`);
      expect(found, "created invoice must appear in the list with a non-empty ref").toBeDefined();
      expect(found!.id.value.length).toBeGreaterThan(0);
    }, 120_000);

    it("UC-import-camt/reconcile-bank: ledger_record_payment settles the test invoice", async () => {
      // The port exposes no bank list yet; fetch directly and pass the bank's
      // GL ACCOUNT CODE — the adapter resolves it to the BankId via getbanks.
      const http = new MeritHttpClient(meritConfig!);
      const banks = await http.post<Array<{ BankId: string; AccountCode?: string; CurrencyCode?: string }>>("getbanks");
      const eurBank = banks.find((b) => b.CurrencyCode === "EUR" && b.AccountCode);
      expect(eurBank, "demo company needs a EUR bank").toBeDefined();

      const paid = await callLedger<{ id: { value: string } }>("ledger_record_payment", {
        backend: "merit",
        payment: {
          bank: { entity: "account", backend: "merit", value: eurBank!.AccountCode! },
          date: new Date().toISOString().slice(0, 10),
          amount: { amount: "0.01", currency: "EUR" },
          allocations: [{ target: invoiceRef, amount: { amount: "0.01", currency: "EUR" } }],
        },
      });
      expect(paid.ok, JSON.stringify(paid.error ?? {})).toBe(true);
      expect(paid.data!.id.value.length).toBeGreaterThan(0);
    }, 120_000);

    it("UC-lightyear-booking: ledger_post_journal posts a marked balanced GL batch", async () => {
      const posted = await callLedger<{ id: { value: string } }>("ledger_post_journal", {
        backend: "merit",
        entry: {
          date: new Date().toISOString().slice(0, 10),
          docNo: `LY:${RUN_KEY}`,
          memo: "E2E test journal (safe to delete)",
          postings: [
            { account: expenseAccount, debit: { amount: "0.01", currency: "EUR" }, memo: "E2E test" },
            { account: expenseAccount, credit: { amount: "0.01", currency: "EUR" }, memo: "E2E test" },
          ],
        },
      });
      expect(posted.ok, JSON.stringify(posted.error ?? {})).toBe(true);
      expect(posted.data!.id.value.length).toBeGreaterThan(0);
    }, 120_000);

    it("UC-void: sales invoice create + ledger_void leaves nothing behind", async () => {
      const parties = await callLedger<Array<{ id: { value: string }; kind: string }>>(
        "ledger_list_parties", { backend: "merit" });
      const customer = parties.data!.find((p) => p.kind === "customer");
      expect(customer, "demo company needs at least one customer").toBeDefined();

      const created = await callLedger<{ id: { value: string } }>("ledger_create_sales_invoice", {
        backend: "merit",
        invoice: {
          customer: { entity: "party", backend: "merit", value: customer!.id.value },
          docDate: new Date().toISOString().slice(0, 10),
          dueDate: new Date().toISOString().slice(0, 10),
          currency: "EUR",
          lines: [{
            item: { code: itemCode, name: "E2E test item" },
            description: "E2E test line (voided immediately)",
            quantity: "1",
            unitPrice: { amount: "0.01", currency: "EUR" },
            taxCode,
            account: expenseAccount,
          }],
        },
      });
      expect(created.ok, JSON.stringify(created.error ?? {})).toBe(true);

      const voided = await callLedger<{ status: string }>("ledger_void", {
        backend: "merit", entity: "salesInvoice", id: created.data!.id.value,
      });
      expect(voided.ok, JSON.stringify(voided.error ?? {})).toBe(true);
      expect(voided.data!.status).toBe("void");
    }, 120_000);

    it("audit log: Merit mutations landed in the backend's own audit file", async () => {
      const auditFile = join(serverCwd, "logs", "merit.audit.md");
      expect(existsSync(auditFile)).toBe(true);
      const content = readFileSync(auditFile, "utf8");
      expect(content).toContain("ledger_create_purchase_invoice");
      expect(content).toContain("ledger_post_journal");
      expect(content).toContain(`${RUN_KEY}-BILL`);
    });
  });
});
