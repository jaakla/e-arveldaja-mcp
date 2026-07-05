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
import { readOnly, create, destructive } from "../annotations.js";
import { parseJsonObject } from "./crud/shared.js";
import type { ApiContext } from "./crud/shared.js";
import { buildLedgerRegistry } from "../ledger/registry.js";
import type { BuildRegistryOptions } from "../ledger/registry.js";
import type { LedgerConnector, ListQuery } from "../ledger/port.js";
import type {
  JournalEntry, Payment, PurchaseInvoice, Ref, Result, SalesInvoice,
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
    "List the chart of accounts on the chosen backend (canonical Account[]: id, code, name, type, requiresDimension).",
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
        return serializeResult(await connector.createSalesInvoice(invoice));
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
        return serializeResult(await connector.recordPayment(payment));
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
        return serializeResult(await connector.postJournal(entry));
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
        return serializeResult(await connector.createPurchaseInvoice(invoice));
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
        return serializeResult(await connector.confirm(makeRef(connector, args.entity, args.id)));
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
        return serializeResult(await connector.void(makeRef(connector, args.entity, args.id)));
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
