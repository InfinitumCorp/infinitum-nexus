import { describe, it, expect } from "vitest";
import { accrue, buildClaim } from "./rewards.ts";

describe("rewards", () => {
  it("accrues at the scaffold rate", () => {
    const r = accrue("user1", 100);
    expect(r.veil).toBe("0.100000");
    expect(r.claimable).toBe(true);
  });

  it("builds a claim payload", () => {
    const r = accrue("user1", 10);
    const claim = buildClaim(r, "0xabc");
    expect(claim.method).toBe("claim");
    expect(claim.to).toBe("0xabc");
  });
});
