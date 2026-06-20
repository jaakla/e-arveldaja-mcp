import { describe, expect, it } from "vitest";
import { formatTimestamp, sign } from "./signer.js";

describe("merit signer", () => {
  // Merit's published test vector — proves the algorithm byte-for-byte.
  it("matches Merit's published HMAC-SHA256 test vector", () => {
    const apiId = "670fe52f-558a-4be8-ade0-526e01a106d0";
    const apiKey = "AoCmZGUfWMMhLJ+Eb6oRF4pAEw9XJP9b/RL5c2Gqk2w=";
    const timestamp = "20240624205902";
    const body =
      '{"CustName":"Kliendinimi","CustId":"3a274294-9c60-4a3d-93f0-1874253f073e","OverDueDays":5,"DebtDate":"20220501"}';
    expect(sign(apiId, timestamp, body, apiKey)).toBe("dt6dkfuj+OfX01YkvvAoN/fekAUGr6AvVlQhUUja9Qc=");
  });

  it("formats timestamps as UTC yyyyMMddHHmmss", () => {
    expect(formatTimestamp(new Date(Date.UTC(2024, 5, 24, 20, 59, 2)))).toBe("20240624205902");
    expect(formatTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe("20260101000000");
  });

  it("signs an empty body deterministically", () => {
    const a = sign("id", "20260101000000", "", "key");
    const b = sign("id", "20260101000000", "", "key");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
