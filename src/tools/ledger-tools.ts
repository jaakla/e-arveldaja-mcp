/**
 * Unified `ledger_*` MCP tools.
 *
 * These route through the LedgerConnector port so an agent can drive either
 * backend (e-arveldaja or Merit Aktiva) with one canonical vocabulary. They do
 * NOT replace the existing e-arveldaja-specific tools; they sit alongside them
 * as the cross-backend surface. Pick the backend with the `backend` arg or let
 * it fall back to the registry default (EARVELDAJA_LEDGER_DEFAULT_BACKEND, else
 * the configured host backend).
 *
 * The read tools (`ledger_list_*`) plus discovery make a non-e-arveldaja
 * backend (e.g. a Merit-only setup) actually usable: you can read back accounts,
 * tax rates, parties, items, and invoices, not just blind-write.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { toolError } from "../tool-error.js";
import { logAudit } from "../audit-log.js";
import { readOnly, create, destructive } from "../annotations.js";
import { parseJsonObject } from "./crud/shared.js";
import type { ApiContext } from "./crud/shared.js";
import { buildLedgerRegistry } from "../ledger/registry.js";
import type { BuildRegistryOptions } from "../ledger/registry.js";
import type { LedgerConnector, ListQuery } from "../ledger/port.js";
import type {
  JournalEntry, Party, Payment, PurchaseInvoice, Ref, Result, SalesInvoice,
} from "../ledger/types.js";

const entityParam = z
  .enum(["salesInvoice", "purchaseInvoice", "journal", "payment"])
  .describe("Which entity the id refers to.");

/** Serialize a port Result, sandbox-wrapping any untrusted upstream detail. */
function serializeResult(result: Result<unknown>): CallToolResult {
  if (result.ok) {
    return { content: [{ type: "text", text: toMcpJson({ ok: true, data: result.data, warnings: result.warnings }) }] };
  }
  const error = { ...result.error };
  if (error.upstreamDetail) error.upstreamDetail = wrapUntrustedOcr(error.upstreamDetail) ?? error.upstreamDetail;
  return { isError: true, content: [{ type: "text", text: toMcpJson({ ok: false, error }) }] };
}

const backendParam = z
  .string()
  .optional()
  .describe('Ledger backend id ("e-arveldaja" or "merit"). Defaults to the registry default (EARVELDAJA_LEDGER_DEFAULT_BACKEND, else the configured host backend). Call list_ledger_backends to see options.');

/** Canonical entity name → the audit log's entity_type vocabulary. */
const AUDIT_ENTITY: Record<string, string> = {
  salesInvoice: "sale_invoice",
  purchaseInvoice: "purchase_invoice",
  journal: "journal",
  payment: "transaction",
  party: "client",
};

/**
 * Audit a successful ledger mutation, mirroring the tool-level logAudit calls
 * the e-arveldaja write tools make. Mutations on a non-e-arveldaja backend are
 * written to that backend's own audit file (logs/<backendId>.audit.md) instead
 * of the active connection's, so another system's writes are never attributed
 * to an e-arveldaja company. Non-numeric backend ids (Merit GUIDs) ride in
 * details.backend_ref because AuditEntry.entity_id is numeric.
 */
function auditLedgerMutation(
  connector: LedgerConnector,
  entry: {
    tool: string;
    action: "CREATED" | "UPDATED" | "CONFIRMED" | "INVALIDATED" | "DELETED";
    entity: string;
    id?: Ref | undefined;
    summary: string;
    details?: Record<string, unknown>;
  },
): void {
  const backendId = connector.capabilities.backendId;
  const numericId = entry.id && /^\d+$/.test(entry.id.value) ? Number(entry.id.value) : undefined;
  logAudit(
    {
      tool: entry.tool,
      action: entry.action,
      entity_type: AUDIT_ENTITY[entry.entity] ?? entry.entity,
      ...(numericId !== undefined ? { entity_id: numericId } : {}),
      summary: entry.summary,
      details: {
        backend: backendId,
        ...(entry.id && numericId === undefined ? { backend_ref: entry.id.value } : {}),
        ...entry.details,
      },
    },
    backendId === "e-arveldaja" ? undefined : { connectionName: backendId },
  );
}

const isoDateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .optional();

export function registerLedgerTools(
  server: McpServer,
  api: ApiContext,
  opts: BuildRegistryOptions = {},
): void {
  const registry = () => buildLedgerRegistry(api, process.env, opts);

  function resolveConnector(backend?: string): LedgerConnector | { error: CallToolResult } {
    const reg = registry();
    const connector = reg.get(backend);
    if (!connector) {
      return {
        error: toolError(
          new Error(
            `Unknown or unconfigured ledger backend "${backend ?? reg.defaultBackend}". ` +
            `Call list_ledger_backends to see available backends.`,
          ),
        ),
      };
    }
    return connector;
  }

  /** Wrap a read that needs a resolved connector, returning a serialized Result. */
  function readTool(
    name: string,
    description: string,
    run: (connector: LedgerConnector, args: LedgerReadArgs) => Promise<Result<unknown>>,
    extraParams: z.ZodRawShape = {},
  ): void {
    registerTool(
      server,
      name,
      description,
      { backend: backendParam, ...extraParams },
      readOnly,
      async (args: LedgerReadArgs) => {
        try {
          const connector = resolveConnector(args.backend);
          if ("error" in connector) return connector.error;
          return serializeResult(await run(connector, args));
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // --- discovery -------------------------------------------------------------

  registerTool(
    server,
    "list_ledger_backends",
    "List the bookkeeping backends reachable through the unified ledger port, with their capabilities " +
      "(booking model, numbering, dimensions, VAT scope, features), whether each is configured, and which is " +
      "the default. Use this first to learn which backend to target and what it supports.",
    {},
    readOnly,
    () => {
      try {
        const reg = registry();
        return { content: [{ type: "text", text: toMcpJson({ default: reg.defaultBackend, backends: reg.list() }) }] };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- reads -----------------------------------------------------------------

  readTool(
    "ledger_list_accounts",
    "List the chart of accounts on the chosen backend (canonical Account[]: id, code, name, plus type and " +
      "requiresDimension when the backend exposes them — Merit does not).",
    (c) => c.listAccounts(),
  );

  readTool(
    "ledger_list_tax_rates",
    "List VAT/tax rates on the chosen backend (canonical TaxRate[]: code, ratePct, optional validity dates).",
    (c) => c.listTaxRates(),
  );

  readTool(
    "ledger_list_parties",
    "List parties (customers/vendors) on the chosen backend (canonical Party[]: id, kind, name, regCode, vatNumber, email, iban).",
    (c) => c.listParties(),
  );

  readTool(
    "ledger_list_items",
    "List products/services on the chosen backend (canonical Item[]: id, code, name, unit).",
    (c) => c.listItems(),
  );

  readTool(
    "ledger_list_sales_invoices",
    "List sales invoices on the chosen backend, optionally bounded by period_start/period_end (YYYY-MM-DD). " +
      "Returns canonical SalesInvoice[] (status, settle, number, customer, dates, currency, total).",
    (c, args) => c.listSalesInvoices(periodQuery(args)),
    { period_start: isoDateParam, period_end: isoDateParam },
  );

  readTool(
    "ledger_list_purchase_invoices",
    "List purchase invoices on the chosen backend, optionally bounded by period_start/period_end (YYYY-MM-DD). " +
      "Returns canonical PurchaseInvoice[] (status, settle, vendor, vendorBillNo, dates, currency, total).",
    (c, args) => c.listPurchaseInvoices(periodQuery(args)),
    { period_start: isoDateParam, period_end: isoDateParam },
  );

  // --- writes ----------------------------------------------------------------

  registerTool(
    server,
    "ledger_upsert_party",
    "Create or update a party (customer/vendor) through the unified ledger port on the chosen backend. " +
      "Accepts a canonical Party object (kind \"customer\"|\"vendor\"|\"both\", name, and optional regCode, " +
      "vatNumber, email, iban). Pass the party's id (a Ref as returned by ledger_list_parties) to update an " +
      "existing party; omit it to create one.",
    {
      backend: backendParam,
      party: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .describe("Canonical Party as a JSON object (or JSON string)."),
    },
    create,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const party = parseJsonObject(args.party, "party") as unknown as Party;
        const isUpdate = party.id !== undefined;
        const result = await connector.upsertParty(party);
        if (result.ok) {
          auditLedgerMutation(connector, {
            tool: "ledger_upsert_party", action: isUpdate ? "UPDATED" : "CREATED", entity: "party",
            id: result.data.id,
            summary: `${isUpdate ? "Updated" : "Created"} party "${result.data.name}" on ${connector.capabilities.label}`,
            details: { name: result.data.name, kind: result.data.kind, reg_code: result.data.regCode },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_create_sales_invoice",
    "Create a sales invoice through the unified ledger port on the chosen backend. Accepts a canonical " +
      "invoice object (customer as a Ref or {name, regCode}, docDate/dueDate as YYYY-MM-DD, currency, and " +
      "lines[] with quantity, unitPrice {amount, currency}, taxCode and account). On Merit the invoice posts " +
      "immediately; on e-arveldaja it is created as a draft to confirm. Backend-specific required fields go " +
      "under `raw`.",
    {
      backend: backendParam,
      invoice: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .describe("Canonical SalesInvoice as a JSON object (or JSON string)."),
    },
    create,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const invoice = parseJsonObject(args.invoice, "invoice") as unknown as SalesInvoice;
        const result = await connector.createSalesInvoice(invoice);
        if (result.ok) {
          auditLedgerMutation(connector, {
            tool: "ledger_create_sales_invoice", action: "CREATED", entity: "salesInvoice",
            id: result.data.id,
            summary: `Created sales invoice${result.data.number ? ` "${result.data.number}"` : ""} on ${connector.capabilities.label}`,
            details: {
              number: result.data.number, doc_date: result.data.docDate,
              currency: result.data.currency, total: result.data.total?.amount,
              lines: result.data.lines?.length,
            },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_record_payment",
    "Record/settle a payment through the unified ledger port. Accepts a canonical Payment object (bank as a " +
      "Ref, date YYYY-MM-DD, amount {amount, currency}, allocations[] each targeting an invoice Ref or " +
      "{account}). On e-arveldaja this confirms an imported bank transaction (pass raw.transaction_id); on " +
      "Merit it posts a payment document.",
    {
      backend: backendParam,
      payment: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .describe("Canonical Payment as a JSON object (or JSON string)."),
    },
    create,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const payment = parseJsonObject(args.payment, "payment") as unknown as Payment;
        const result = await connector.recordPayment(payment);
        if (result.ok) {
          // On an explicit-booking backend this confirms an existing bank
          // transaction; on an auto-post backend it creates a payment document.
          const explicit = connector.capabilities.bookingModel === "explicit";
          auditLedgerMutation(connector, {
            tool: "ledger_record_payment", action: explicit ? "CONFIRMED" : "CREATED", entity: "payment",
            id: result.data.id,
            summary: `${explicit ? "Confirmed" : "Recorded"} payment of ${result.data.amount?.amount} ${result.data.amount?.currency} on ${connector.capabilities.label}`,
            details: {
              date: result.data.date, amount: result.data.amount?.amount,
              currency: result.data.amount?.currency, allocations: result.data.allocations?.length,
            },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_post_journal",
    "Post a manual journal entry through the unified ledger port. Accepts a canonical JournalEntry (date " +
      "YYYY-MM-DD, postings[] each with account, and either debit or credit as {amount, currency}). The " +
      "postings must balance. On Merit this becomes a GL batch the backend posts; on e-arveldaja it becomes " +
      "an explicit journal.",
    {
      backend: backendParam,
      entry: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .describe("Canonical JournalEntry as a JSON object (or JSON string)."),
    },
    create,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const entry = parseJsonObject(args.entry, "entry") as unknown as JournalEntry;
        const result = await connector.postJournal(entry);
        if (result.ok) {
          auditLedgerMutation(connector, {
            tool: "ledger_post_journal", action: "CREATED", entity: "journal",
            id: result.data.id,
            summary: `Posted journal${result.data.docNo ? ` "${result.data.docNo}"` : ""} (${result.data.postings?.length ?? 0} postings) on ${connector.capabilities.label}`,
            details: { date: result.data.date, memo: result.data.memo, postings: result.data.postings?.length },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_create_purchase_invoice",
    "Create a purchase invoice through the unified ledger port on the chosen backend. Accepts a canonical " +
      "PurchaseInvoice (vendor as a Ref or {name, regCode}, vendorBillNo, docDate/dueDate as YYYY-MM-DD, " +
      "currency, lines[] with quantity, unitPrice {amount, currency}, taxCode and account). On Merit it posts " +
      "immediately; on e-arveldaja it is created as a draft to confirm. Backend-specific required fields go " +
      "under `raw`.",
    {
      backend: backendParam,
      invoice: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .describe("Canonical PurchaseInvoice as a JSON object (or JSON string)."),
    },
    create,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const invoice = parseJsonObject(args.invoice, "invoice") as unknown as PurchaseInvoice;
        const result = await connector.createPurchaseInvoice(invoice);
        if (result.ok) {
          auditLedgerMutation(connector, {
            tool: "ledger_create_purchase_invoice", action: "CREATED", entity: "purchaseInvoice",
            id: result.data.id,
            summary: `Created purchase invoice${result.data.vendorBillNo ? ` "${result.data.vendorBillNo}"` : ""} on ${connector.capabilities.label}`,
            details: {
              vendor_bill_no: result.data.vendorBillNo, doc_date: result.data.docDate,
              currency: result.data.currency, total: result.data.total?.amount,
              lines: result.data.lines?.length,
            },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_confirm",
    "Confirm/register a document on the chosen backend (transition draft → confirmed). On e-arveldaja this " +
      "performs the real register; on an auto-post backend like Merit, documents are already posted so this " +
      "reports the steady state. Identify the document with entity + id.",
    { backend: backendParam, entity: entityParam, id: z.string().describe("The document id (backend-native).") },
    destructive,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const ref = makeRef(connector, args.entity, args.id);
        const result = await connector.confirm(ref);
        // Only audit on explicit-booking backends; on auto-post backends
        // confirm() is a status read that mutates nothing.
        if (result.ok && connector.capabilities.bookingModel === "explicit") {
          auditLedgerMutation(connector, {
            tool: "ledger_confirm", action: "CONFIRMED", entity: args.entity, id: ref,
            summary: `Confirmed ${args.entity} ${args.id} on ${connector.capabilities.label}`,
            details: { status: result.data.status },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  registerTool(
    server,
    "ledger_void",
    "Void a document on the chosen backend (e-arveldaja: invalidate back to draft; Merit: delete the " +
      "document — only sale invoices are wired). Identify the document with entity + id. IRREVERSIBLE.",
    { backend: backendParam, entity: entityParam, id: z.string().describe("The document id (backend-native).") },
    destructive,
    async (args) => {
      try {
        const connector = resolveConnector(args.backend);
        if ("error" in connector) return connector.error;
        const ref = makeRef(connector, args.entity, args.id);
        const result = await connector.void(ref);
        if (result.ok) {
          // Explicit backends invalidate (reversible to draft); auto-post
          // backends delete the document outright.
          const explicit = connector.capabilities.bookingModel === "explicit";
          auditLedgerMutation(connector, {
            tool: "ledger_void", action: explicit ? "INVALIDATED" : "DELETED", entity: args.entity, id: ref,
            summary: `Voided ${args.entity} ${args.id} on ${connector.capabilities.label}`,
            details: { status: result.data.status },
          });
        }
        return serializeResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

function makeRef(connector: LedgerConnector, entity: string, id: string): Ref {
  return { entity, backend: connector.capabilities.backendId, value: id };
}

interface LedgerReadArgs {
  backend?: string;
  period_start?: string;
  period_end?: string;
}

function periodQuery(args: { period_start?: string; period_end?: string }): ListQuery {
  return {
    ...(args.period_start ? { periodStart: args.period_start } : {}),
    ...(args.period_end ? { periodEnd: args.period_end } : {}),
  };
}
