import { describe, expect, it } from "vitest";
import { buildLedgerRegistry } from "./registry.js";
import type { ApiContext } from "../tools/crud/shared.js";

const api = {} as ApiContext; // adapters are constructed lazily; no calls in these tests

describe("buildLedgerRegistry", () => {
  it("always exposes e-arveldaja and defaults to it when Merit is unconfigured", () => {
    const reg = buildLedgerRegistry(api, {});
    expect(reg.defaultBackend).toBe("e-arveldaja");
    expect(reg.get()).toBeDefined();
    expect(reg.get("merit")).toBeUndefined();
    const merit = reg.list().find((b) => b.backendId === "merit")!;
    expect(merit.configured).toBe(false);
    expect(merit.note).toContain("MERIT_API_ID");
  });

  it("registers Merit when credentials are present", () => {
    const reg = buildLedgerRegistry(api, { MERIT_API_ID: "id", MERIT_API_KEY: "key" });
    expect(reg.get("merit")).toBeDefined();
    expect(reg.list().find((b) => b.backendId === "merit")!.configured).toBe(true);
  });

  it("honours EARVELDAJA_LEDGER_DEFAULT_BACKEND when that backend is configured", () => {
    const reg = buildLedgerRegistry(api, { MERIT_API_ID: "id", MERIT_API_KEY: "key", EARVELDAJA_LEDGER_DEFAULT_BACKEND: "merit" });
    expect(reg.defaultBackend).toBe("merit");
    expect(reg.get()!.capabilities.backendId).toBe("merit");
  });

  it("ignores a default pointing at an unconfigured backend", () => {
    const reg = buildLedgerRegistry(api, { EARVELDAJA_LEDGER_DEFAULT_BACKEND: "merit" });
    expect(reg.defaultBackend).toBe("e-arveldaja");
  });
});
