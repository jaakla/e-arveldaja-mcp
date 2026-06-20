/** Small helpers for the `Result` envelope used across the ledger port. */
import type { LedgerError, Result, Warning } from "./types.js";

export function ok<T>(data: T, warnings?: Warning[]): Result<T> {
  return warnings && warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data };
}

export function fail<T = never>(error: LedgerError): Result<T> {
  return { ok: false, error };
}

/**
 * Return the data from a successful Result, or throw an Error carrying the
 * LedgerError's message and structured fields. Used at the tool boundary so a
 * backend failure propagates (and is serialized by the MCP error path) the same
 * way a thrown HttpError did before a tool was migrated onto the port.
 */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  const err = Object.assign(new Error(result.error.message), { code: result.error.code });
  if (result.error.upstreamDetail !== undefined) {
    (err as { upstream_detail?: string }).upstream_detail = result.error.upstreamDetail;
  }
  if (result.error.retryable !== undefined) {
    (err as { retryable?: boolean }).retryable = result.error.retryable;
  }
  throw err;
}

/**
 * Map an arbitrary thrown error onto a `LedgerError`. Recognizes the repo's
 * `HttpError` shape (a `status` of number | "network" plus optional
 * `upstream_detail`) without importing it, so this stays backend-neutral.
 */
export function fromThrown(err: unknown): LedgerError {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status?: unknown; message?: unknown; upstream_detail?: unknown };
    const status = e.status;
    const message = typeof e.message === "string" ? e.message : String(err);
    const upstreamDetail = typeof e.upstream_detail === "string" ? e.upstream_detail : undefined;
    let code: LedgerError["code"] = "upstream";
    let retryable = false;
    if (status === 401 || status === 403) code = "auth";
    else if (status === 404) code = "not_found";
    else if (status === 409) code = "conflict";
    else if (status === 400 || status === 422) code = "validation";
    else if (status === 429) { code = "rate_limited"; retryable = true; }
    else if (status === "network") { code = "upstream"; retryable = true; }
    return { code, message, upstreamDetail, retryable };
  }
  return { code: "upstream", message: err instanceof Error ? err.message : String(err) };
}
