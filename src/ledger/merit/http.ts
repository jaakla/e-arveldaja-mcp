/**
 * Minimal authenticated transport for the Merit Aktiva REST API.
 *
 * Every Merit endpoint is POST-with-JSON (even reads). Auth is three query
 * params (apiId, timestamp, signature). We sign the exact serialized body that
 * goes on the wire. Errors are thrown with a `status` field so the ledger
 * `fromThrown` mapper can categorize them like the e-arveldaja HttpClient does.
 */
import type { MeritConfig } from "./config.js";
import { formatTimestamp, sign } from "./signer.js";

export class MeritHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | "network",
    public readonly endpoint: string,
    public readonly upstream_detail?: string,
  ) {
    super(message);
    this.name = "MeritHttpError";
  }
}

export interface MeritHttp {
  post<T = unknown>(endpoint: string, body?: unknown, opts?: { version?: "v1" | "v2" }): Promise<T>;
}

export class MeritHttpClient implements MeritHttp {
  constructor(
    private config: MeritConfig,
    private fetchImpl: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {}

  async post<T = unknown>(endpoint: string, body?: unknown, opts?: { version?: "v1" | "v2" }): Promise<T> {
    const version = opts?.version ?? "v1";
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const timestamp = formatTimestamp(this.now());
    const signature = sign(this.config.apiId, timestamp, bodyStr, this.config.apiKey);

    const qs = new URLSearchParams({ apiId: this.config.apiId, timestamp, signature });
    const url = `${this.config.baseUrl}/api/${version}/${endpoint}?${qs.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: bodyStr.length > 0 ? bodyStr : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new MeritHttpError(
        `Merit request failed: POST ${endpoint} → network error`,
        "network",
        endpoint,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new MeritHttpError(
        `Merit request failed: POST ${endpoint} → ${response.status}`,
        response.status,
        endpoint,
        text.slice(0, 500),
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Merit occasionally returns a bare quoted string (e.g. "OK"); surface raw.
      return text as unknown as T;
    }
  }
}
