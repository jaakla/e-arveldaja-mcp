/**
 * Opt-in live smoke test for the Merit adapter.
 *
 * Runs ONLY when MERIT_API_ID and MERIT_API_KEY are set (point them at a Merit
 * demo company). Skipped otherwise, so CI without credentials stays green.
 *
 *   MERIT_API_ID=... MERIT_API_KEY=... npm run test:integration
 *
 * It performs read-only calls (capabilities + chart of accounts + tax rates)
 * so it never mutates the target company.
 */
import { describe, expect, it } from "vitest";
import { MeritAdapter } from "../ledger/merit/adapter.js";
import { MeritHttpClient } from "../ledger/merit/http.js";
import { getMeritConfig } from "../ledger/merit/config.js";

const config = getMeritConfig();
const run = config ? describe : describe.skip;

run("Merit adapter (live, read-only)", () => {
  const adapter = new MeritAdapter(new MeritHttpClient(config!));

  it("reads the chart of accounts", async () => {
    const res = await adapter.listAccounts();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data[0]!.id.backend).toBe("merit");
    // Every account must carry a real backend ref and code — an upstream field
    // rename (e.g. Id vs AccountID) must fail here, not silently map to "".
    expect(res.data.every((a) => a.id.value.length > 0)).toBe(true);
    expect(res.data.every((a) => typeof a.code === "string" && a.code.length > 0)).toBe(true);
  }, 30000);

  it("reads VAT rates", async () => {
    const res = await adapter.listTaxRates();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.every((t) => typeof t.ratePct === "number")).toBe(true);
  }, 30000);
});
