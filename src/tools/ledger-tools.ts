/**
 * Unified `ledger_*` MCP tools.
 *
 * These route through the LedgerConnector port so an agent can drive either
 * backend (e-arveldaja or Merit Aktiva) with one canonical vocabulary. They do
 * NOT replace the existing e-arveldaja-specific tools; they sit alongside them
 * as the cross-backend surface. Pick the backend with the `backend` arg or let
 * it fall back to EARVELDAJA_LEDGER_DEFAULT_BACKEND.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { toolError } from "../tool-error.js";
import { readOnly, create } from "../annotations.js";
import { parseJsonObject } from "./crud/shared.js";
import type { ApiContext } from "./crud/shared.js";
import { buildLedgerRegistry } from "../ledger/registry.js";
import type { LedgerConnector } from "../ledger/port.js";
import type {
  JournalEntry, Payment, Result, SalesInvoice,
} from "../ledger/types.js";

/** Serialize a port Result, sandbox-wrapping any untrusted upstream detail. */
function serializeResult(result: Result<unknown>): CallToolResult {
  if (result.ok) {
    return { content: [{ type: "text", text: toMcpJson({ ok: true, data: result.data, warnings: result.warnings }) }] };
  }
  const error = { ...result.error };
  if (error.upstreamDetail) error.upstreamDetail = wrapUntrustedOcr(error.upstreamDetail) ?? error.upstreamDetail;
  return { isError: true, content: [{ type: "text", text: toMcpJson({ ok: false, error }) }] };
}

function resolveConnector(api: ApiContext, backend?: string): LedgerConnector | { error: CallToolResult } {
  const registry = buildLedgerRegistry(api);
  const connector = registry.get(backend);
  if (!connector) {
    return {
      error: toolError(
        new Error(
          `Unknown or unconfigured ledger backend "${backend ?? registry.defaultBackend}". ` +
          `Call list_ledger_backends to see available backends.`,
        ),
      ),
    };
  }
  return connector;
}

const backendParam = z
  .string()
  .optional()
  .describe('Ledger backend id ("e-arveldaja" or "merit"). Defaults to EARVELDAJA_LEDGER_DEFAULT_BACKEND, else e-arveldaja.');

export function registerLedgerTools(server: McpServer, api: ApiContext): void {
  registerTool(
    server,
    "list_ledger_backends",
    "List the bookkeeping backends reachable through the unified ledger port, with their capabilities " +
      "(booking model, numbering, dimensions, VAT scope, features) and whether each is configured. " +
      "Use this first to learn which backend to target and what it supports.",
    {},
    readOnly,
    () => {
      try {
        const registry = buildLedgerRegistry(api);
        return { content: [{ type: "text", text: toMcpJson({ default: registry.defaultBackend, backends: registry.list() }) }] };
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
        const connector = resolveConnector(api, args.backend);
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
        const connector = resolveConnector(api, args.backend);
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
        const connector = resolveConnector(api, args.backend);
        if ("error" in connector) return connector.error;
        const entry = parseJsonObject(args.entry, "entry") as unknown as JournalEntry;
        return serializeResult(await connector.postJournal(entry));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
