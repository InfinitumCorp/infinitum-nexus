import { describe, expect, it } from "vitest";
import { geoRoutingFromPrefs, walletGeo } from "../src/geo.ts";

describe("geo routing", () => {
  it("stays off unless the settings switch is on", () => {
    expect(geoRoutingFromPrefs({ geoRouting: false })).toBe(false);
    expect(geoRoutingFromPrefs({})).toBe(false);
    expect(walletGeo(false).enabled).toBe(false);
    expect(walletGeo(false).lookupCountry("203.0.113.9")).toBeNull();
    expect(walletGeo(true).lookupCountry("203.0.113.9")).toBeNull();
  });
});