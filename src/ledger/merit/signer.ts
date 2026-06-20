/**
 * Merit Aktiva request signing.
 *
 * Every Merit API call is authenticated with three query-string parameters:
 * apiId, timestamp, signature. The signature is an HMAC-SHA256 over
 * apiId + timestamp + httpBody, keyed by the API key string verbatim (NOT
 * base64-decoded), base64-encoded.
 *
 *   dataToSign := utf8( apiId + timestamp + httpBody )
 *   signature  := base64( hmac_sha256(utf8(apiKey), dataToSign) )
 *
 * Verified against Merit's published test vector (see signer.test.ts):
 *   apiId     670fe52f-558a-4be8-ade0-526e01a106d0
 *   apiKey    AoCmZGUfWMMhLJ+Eb6oRF4pAEw9XJP9b/RL5c2Gqk2w=
 *   timestamp 20240624205902
 *   body      {"CustName":"Kliendinimi","CustId":"3a274294-9c60-4a3d-93f0-1874253f073e","OverDueDays":5,"DebtDate":"20220501"}
 *   signature dt6dkfuj+OfX01YkvvAoN/fekAUGr6AvVlQhUUja9Qc=
 *
 * The body MUST be the exact byte string sent on the wire, so the client signs
 * the already-serialized body, never a re-serialization of it.
 */
import { createHmac } from "node:crypto";

/** Format a Date as Merit's required UTC timestamp: `yyyyMMddHHmmss`. */
export function formatTimestamp(date: Date): string {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    p(date.getUTCFullYear(), 4) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  );
}

/** Compute the base64 HMAC-SHA256 signature for a Merit API request. */
export function sign(apiId: string, timestamp: string, body: string, apiKey: string): string {
  const dataToSign = `${apiId}${timestamp}${body}`;
  return createHmac("sha256", Buffer.from(apiKey, "utf8")).update(dataToSign, "utf8").digest("base64");
}
