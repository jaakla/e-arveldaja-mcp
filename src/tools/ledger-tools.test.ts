import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerLedgerTools } from "./ledger-tools.js";
import { logAudit } from "../audit-log.js";
import type { LedgerConnector } from "../ledger/port.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

// The tools build the registry per call; give them one whose default connector
// is whatever the test installs.
let currentConnector: LedgerConnector;
vi.mock("../ledger/registry.js", () => ({
  buildLedgerRegistry: () => ({
    connectors: new Map(),
    defaultBackend: currentConnector.capabilities.backendId,
    get: (backend?: string) =>
      backend === undefined || backend === currentConnector.capabilities.backendId
        ? currentConnector
        : undefined,
    list: () => [],
  }),
}));

function meritConnector(overrides: Partial<LedgerConnector> = {}): LedgerConnector {
  return {
    capabilities: {
      backendId: "merit", label: "Merit Aktiva", numbering: "callerAssigned",
      bookingModel: "autoPost", refFormat: "guid", dimensionModel: "fixedAxes",
      vatScope: "perLine", requiresSourceDocOnEntry: false, writeTransport: "same",
      features: {},
    },
    ...overrides,
  } as LedgerConnector;
}

function earveldajaConnector(overrides: Partial<LedgerConnector> = {}): LedgerConnector {
  return {
    capabilities: {
      backendId: "e-arveldaja", label: "e-arveldaja", numbering: "seriesManaged",
      bookingModel: "explicit", refFormat: "int", dimensionModel: "namedObjects",
      vatScope: "perLine", requiresSourceDocOnEntry: true, writeTransport: "same",
      features: {},
    },
    ...overrides,
  } as LedgerConnector;
}

function getHandler(toolName: string) {
  const server = { registerTool: vi.fn() };
  registerLedgerTools(server as never, {} as never);
  const call = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!call) throw new Error(`${toolName} tool was not registered`);
  return call[2] as (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;
}

beforeEach(() => {
  vi.mocked(logAudit).mockClear();
});

describe("ledger tool audit logging", () => {
  it("logs a Merit sales-invoice create to the merit audit file with the GUID as backend_ref", async () => {
    currentConnector = meritConnector({
      createSalesInvoice: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: { entity: "salesInvoice", backend: "merit", value: "AB-12-GUID" },
          number: "A-7", docDate: "2026-07-01", dueDate: "2026-07-14",
          currency: "EUR", lines: [], total: { amount: "100.00", currency: "EUR" },
        },
      }),
    });
    const handler = getHandler("ledger_create_sales_invoice");

    const res = await handler({ invoice: { docDate: "2026-07-01", lines: [] } });

    expect(res.isError).toBeFalsy();
    expect(logAudit).toHaveBeenCalledTimes(1);
    const [entry, opts] = vi.mocked(logAudit).mock.calls[0]!;
    expect(entry).toMatchObject({
      tool: "ledger_create_sales_invoice", action: "CREATED", entity_type: "sale_invoice",
      details: expect.objectContaining({ backend: "merit", backend_ref: "AB-12-GUID", number: "A-7" }),
    });
    expect(entry).not.toHaveProperty("entity_id");
    expect(opts).toEqual({ connectionName: "merit" });
  });

  it("logs an e-arveldaja create to the active connection's log with a numeric entity_id", async () => {
    currentConnector = earveldajaConnector({
      createPurchaseInvoice: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: { entity: "purchaseInvoice", backend: "e-arveldaja", value: "4711" },
          vendorBillNo: "INV-9", docDate: "2026-07-01", dueDate: "2026-07-14",
          currency: "EUR", lines: [{}],
        },
      }),
    });
    const handler = getHandler("ledger_create_purchase_invoice");

    await handler({ invoice: { vendorBillNo: "INV-9", lines: [{}] } });

    const [entry, opts] = vi.mocked(logAudit).mock.calls[0]!;
    expect(entry).toMatchObject({
      tool: "ledger_create_purchase_invoice", action: "CREATED",
      entity_type: "purchase_invoice", entity_id: 4711,
    });
    expect(opts).toBeUndefined();
  });

  it("does not log when the backend rejects the write", async () => {
    currentConnector = meritConnector({
      postJournal: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "validation", message: "postings do not balance" },
      }),
    });
    const handler = getHandler("ledger_post_journal");

    const res = await handler({ entry: { date: "2026-07-01", postings: [] } });

    expect(res.isError).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("record_payment logs CONFIRMED on an explicit backend and CREATED on auto-post", async () => {
    const payment = {
      ok: true,
      data: { id: undefined, date: "2026-07-01", amount: { amount: "50.00", currency: "EUR" }, allocations: [] },
    };
    currentConnector = earveldajaConnector({ recordPayment: vi.fn().mockResolvedValue(payment) });
    await getHandler("ledger_record_payment")({ payment: { date: "2026-07-01", allocations: [] } });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({ action: "CONFIRMED", entity_type: "transaction" });

    vi.mocked(logAudit).mockClear();
    currentConnector = meritConnector({ recordPayment: vi.fn().mockResolvedValue(payment) });
    await getHandler("ledger_record_payment")({ payment: { date: "2026-07-01", allocations: [] } });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({ action: "CREATED", entity_type: "transaction" });
  });

  it("ledger_confirm audits only on explicit-booking backends", async () => {
    const confirmed = { ok: true, data: { status: "confirmed" } };
    currentConnector = meritConnector({ confirm: vi.fn().mockResolvedValue(confirmed) });
    await getHandler("ledger_confirm")({ entity: "salesInvoice", id: "GUID-1" });
    expect(logAudit).not.toHaveBeenCalled();

    currentConnector = earveldajaConnector({ confirm: vi.fn().mockResolvedValue(confirmed) });
    await getHandler("ledger_confirm")({ entity: "journal", id: "42" });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({
      tool: "ledger_confirm", action: "CONFIRMED", entity_type: "journal", entity_id: 42,
    });
  });

  it("ledger_void logs INVALIDATED on explicit backends and DELETED on auto-post", async () => {
    const voided = { ok: true, data: { status: "void" } };
    currentConnector = earveldajaConnector({ void: vi.fn().mockResolvedValue(voided) });
    await getHandler("ledger_void")({ entity: "salesInvoice", id: "42" });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({ action: "INVALIDATED" });

    vi.mocked(logAudit).mockClear();
    currentConnector = meritConnector({ void: vi.fn().mockResolvedValue(voided) });
    await getHandler("ledger_void")({ entity: "salesInvoice", id: "GUID-1" });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({ action: "DELETED" });
  });
});

describe("ledger_upsert_party", () => {
  it("creates a party and logs CREATED with entity_type client", async () => {
    const upsertParty = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: { entity: "party", backend: "merit", value: "GUID-P" }, kind: "customer", name: "ACME OÜ" },
    });
    currentConnector = meritConnector({ upsertParty });
    const handler = getHandler("ledger_upsert_party");

    const res = await handler({ party: { kind: "customer", name: "ACME OÜ" } });

    expect(res.isError).toBeFalsy();
    expect(upsertParty).toHaveBeenCalledWith({ kind: "customer", name: "ACME OÜ" });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({
      tool: "ledger_upsert_party", action: "CREATED", entity_type: "client",
      summary: expect.stringContaining("ACME OÜ"),
    });
  });

  it("logs UPDATED when the party carries an id", async () => {
    currentConnector = earveldajaConnector({
      upsertParty: vi.fn().mockResolvedValue({
        ok: true,
        data: { id: { entity: "party", backend: "e-arveldaja", value: "5" }, kind: "vendor", name: "Tarnija AS" },
      }),
    });
    const handler = getHandler("ledger_upsert_party");

    await handler({
      party: { id: { entity: "party", backend: "e-arveldaja", value: "5" }, kind: "vendor", name: "Tarnija AS" },
    });

    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({
      action: "UPDATED", entity_type: "client", entity_id: 5,
    });
  });
});
