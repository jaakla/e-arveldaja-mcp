import { describe, expect, it, vi } from "vitest";
import { MeritHttpClient, MeritHttpError } from "./http.js";
import type { MeritConfig } from "./config.js";

const config: MeritConfig = {
  apiId: "test-id",
  apiKey: "test-key",
  baseUrl: "https://aktiva.merit.ee",
  country: "EE",
};

/** Client with timing collapsed so tests run instantly. */
function makeClient(fetchImpl: typeof fetch, minIntervalMs = 0) {
  return new MeritHttpClient(config, fetchImpl, () => new Date("2026-01-01T00:00:00Z"), {
    minIntervalMs,
    retryDelayMs: 0,
  });
}

describe("MeritHttpClient retry behaviour", () => {
  it("retries once on 429 and returns the second response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ Id: "x" }]), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("sendinvoice", { a: 1 })).resolves.toEqual([{ Id: "x" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the single retry when 429 persists", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("slow down", { status: 429 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("getcustomers")).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error on an idempotent get* endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("getcustomers", {})).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a network error on a send* endpoint (double-post risk)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("sendinvoice", { a: 1 })).rejects.toBeInstanceOf(MeritHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-429 HTTP errors", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("bad", { status: 400 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.post("getcustomers")).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("MeritHttpClient rate limiting", () => {
  it("spaces sequential requests by at least minIntervalMs", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, 40);

    const start = Date.now();
    await client.post("getcustomers");
    await client.post("getcustomers");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(35); // 40ms interval minus timer slop
  });

  it("spaces concurrently-submitted requests through the same limiter", async () => {
    const startTimes: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now());
      return new Response("[]", { status: 200 });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch, 30);

    await Promise.all([client.post("getcustomers"), client.post("getitems")]);
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(25); // 30ms minus timer slop
  });
});
