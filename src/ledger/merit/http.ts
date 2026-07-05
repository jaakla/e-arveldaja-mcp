/**
 * Minimal authenticated transport for the Merit Aktiva REST API.
 *
 * Every Merit endpoint is POST-with-JSON (even reads). Auth is three query
 * params (apiId, timestamp, signature). We sign the exact serialized body that
 * goes on the wire. Errors are thrown with a `status` field so the ledger
 * `fromThrown` mapper can categorize them like the e-arveldaja HttpClient does.
 *
 * Hardening (mirrors the e-arveldaja HttpClient posture):
 *  - Requests are serialized with a minimum interval — Merit throttles per
 *    API key (~60 requests/minute), so the default paces to ~1 req/s.
 *  - One retry on 429 (the request was rejected before processing, so it is
 *    safe for any endpoint). Network errors are retried only for `get*`
 *    endpoints: since every Merit call is a POST, a network failure after a
 *    `send*` may have reached Merit, and retrying could double-post a document.
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

export interface MeritHttpTiming {
  /** Minimum ms between requests (default 1000 — Merit throttles ~60 req/min per key). */
  minIntervalMs?: number;
  /** Delay in ms before the single retry of a retryable failure (default 1500). */
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MeritHttpClient implements MeritHttp {
  private lastRequest = Promise.resolve();
  private nextAllowedAt = 0;
  private readonly minIntervalMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private config: MeritConfig,
    private fetchImpl: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
    timing: MeritHttpTiming = {},
  ) {
    this.minIntervalMs = timing.minIntervalMs ?? 1_000;
    this.retryDelayMs = timing.retryDelayMs ?? 1_500;
  }

  private async waitForRateLimitTurn(): Promise<void> {
    const enforce = async () => {
      const delayMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (delayMs > 0) await sleep(delayMs);
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
    };
    // Assign before awaiting so concurrent callers chain off this promise
    const myTurn = this.lastRequest.then(enforce, enforce);
    this.lastRequest = myTurn;
    await myTurn;
  }

  async post<T = unknown>(endpoint: string, body?: unknown, opts?: { version?: "v1" | "v2" }): Promise<T> {
    // Merit endpoint naming (get* vs send*) is the idempotency signal — every
    // call is a POST, so the HTTP method cannot distinguish reads from writes.
    const idempotent = /^get/i.test(endpoint);
    for (let attempt = 0; ; attempt++) {
      await this.waitForRateLimitTurn();
      try {
        return await this.postOnce<T>(endpoint, body, opts);
      } catch (err) {
        const retryable =
          attempt === 0 &&
          err instanceof MeritHttpError &&
          (err.status === 429 || (err.status === "network" && idempotent));
        if (!retryable) throw err;
        await sleep(this.retryDelayMs);
      }
    }
  }

  private async postOnce<T>(endpoint: string, body?: unknown, opts?: { version?: "v1" | "v2" }): Promise<T> {
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
