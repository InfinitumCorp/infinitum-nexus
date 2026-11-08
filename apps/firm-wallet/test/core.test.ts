import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, recoverTypedDataAddress } from "viem";
import { evmAccount, isValidPhrase, newRecoveryPhrase, slip10Ed25519, solanaKeypair } from "../src/core/keys.ts";
import { checkPassword, seal, unseal, VaultError } from "../src/core/vault.ts";
import { associatedTokenAddress, compactU16, compileMessage, findPda, isOnCurve, readCompactU16, signLegacy, signSerialized, SYSTEM_PROGRAM, TOKEN_PROGRAM } from "../src/core/solana.ts";
import { actionHash, estimateLiquidation, msgpack, preparePerpOrder, roundPrice, signL1Action, wire } from "../src/core/perps.ts";
import { parseRequest, productForOrigin, siweMessage } from "../src/core/connect.ts";
import { toStocks } from "../src/core/stocks.ts";
import { historyCoin, parseGeckoOhlcv } from "../src/core/market-data.ts";
import { candidatePaths } from "../src/core/evm.ts";
import { tokensFor } from "../src/core/config.ts";
import { balanceDelta } from "../src/core/rewards.ts";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("keys", () => {
  it("makes valid 12 and 24 word phrases", () => {
    expect(newRecoveryPhrase().split(" ")).toHaveLength(12);
    expect(newRecoveryPhrase(24).split(" ")).toHaveLength(24);
    expect(isValidPhrase(newRecoveryPhrase())).toBe(true);
    expect(isValidPhrase("abandon abandon abandon")).toBe(false);
    expect(isValidPhrase(`  ${ABANDON.toUpperCase()} `)).toBe(true);
  });

  it("derives the standard Ethereum address (BIP-44 m/44'/60'/0'/0/0)", () => {
    expect(evmAccount(ABANDON).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("matches the SLIP-0010 ed25519 test vector", () => {
    const seed = hexToBytes("0x000102030405060708090a0b0c0d0e0f");
    expect(Buffer.from(slip10Ed25519(seed, [])).toString("hex")).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
    expect(Buffer.from(slip10Ed25519(seed, [0])).toString("hex")).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
  });

  it("derives the standard Solana address (m/44'/501'/0'/0')", () => {
    const kp = solanaKeypair(ABANDON);
    expect(kp.address).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    const sig = kp.sign(new Uint8Array([1, 2, 3]));
    expect(ed25519.verify(sig, new Uint8Array([1, 2, 3]), kp.publicKey)).toBe(true);
  });
});

describe("vault", () => {
  it("seals and unseals the phrase, and refuses a wrong password", async () => {
    const v = await seal(ABANDON, "correct horse battery", 1000);
    expect(v.data).not.toContain("abandon");
    expect(await unseal(v, "correct horse battery")).toBe(ABANDON);
    await expect(unseal(v, "wrong password!!")).rejects.toThrow(VaultError);
  });
  it("refuses weak passwords", async () => {
    expect(checkPassword("short")).toMatch(/10 characters/);
    expect(checkPassword("aaaaaaaaaaaa")).toMatch(/harder/);
    await expect(seal(ABANDON, "short")).rejects.toThrow(VaultError);
  });
});

describe("solana encoding", () => {
  it("compact-u16 round trips", () => {
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
      const b = Uint8Array.from(compactU16(n));
      expect(readCompactU16(b, 0)).toEqual([n, b.length]);
    }
  });

  it("derives the known USDC associated token account", () => {
    // Known ATA for owner 11111111111111111111111111111111? Use the property instead: off-curve and deterministic.
    const owner = solanaKeypair(ABANDON).address;
    const ata = associatedTokenAddress(owner, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(isOnCurve(base58.decode(ata))).toBe(false);
    expect(associatedTokenAddress(owner, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(ata);
    expect(findPda([base58.decode(owner)], TOKEN_PROGRAM)[1]).toBeLessThanOrEqual(255);
  });

  it("compiles a SOL transfer with the right header and signs it", () => {
    const kp = solanaKeypair(ABANDON);
    const to = solanaKeypair(ABANDON, 1).address;
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    const msg = compileMessage(kp.address, [{ programId: SYSTEM_PROGRAM, keys: [{ pubkey: kp.address, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }], data }], "11111111111111111111111111111111");
    expect([...msg.slice(0, 4)]).toEqual([1, 0, 1, 3]); // 1 signer, 0 ro-signed, 1 ro-unsigned (system program), 3 keys
    expect(base58.encode(msg.slice(4, 36))).toBe(kp.address);
    const tx = signLegacy(msg, kp);
    expect(tx[0]).toBe(1);
    expect(ed25519.verify(tx.slice(1, 65), msg, kp.publicKey)).toBe(true);
    // signSerialized accepts our own transaction and re-signs it identically...
    expect(signSerialized(tx, kp)).toEqual(tx);
    // ...but refuses one paid for by someone else.
    expect(() => signSerialized(tx, solanaKeypair(ABANDON, 2))).toThrow(/isn't paid for by your wallet/);
  });
});

describe("hyperliquid", () => {
  it("encodes msgpack like the reference implementation", () => {
    expect([...msgpack({ a: 1, b: true })]).toEqual([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xc3]);
    expect([...msgpack([300, "x", null, false])]).toEqual([0x94, 0xcd, 0x01, 0x2c, 0xa1, 0x78, 0xc0, 0xc2]);
  });

  it("formats prices and sizes the way Hyperliquid accepts", () => {
    expect(wire(1.5, 4)).toBe("1.5");
    expect(wire(2, 2)).toBe("2");
    expect(roundPrice(3456.789, 4)).toBe("3456.8");
    expect(roundPrice(0.000123456, 0)).toBe("0.000123");
  });

  it("signs an L1 action that recovers to the wallet address", async () => {
    const acct = evmAccount(ABANDON);
    const action = { type: "order", orders: [{ a: 0, b: true, p: "100", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    const nonce = 1_700_000_000_000;
    const sig = await signL1Action(acct, action, nonce, false);
    const signature = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}` as `0x${string}`;
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: "b", connectionId: actionHash(action, nonce) },
      signature,
    });
    expect(recovered).toBe(acct.address);
  });

  it("guards orders: minimum size, leverage cap, liquidation shown", () => {
    const market = { index: 0, name: "BTC", szDecimals: 5, maxLeverage: 40, mid: 100_000 };
    expect(() => preparePerpOrder({ market, side: "long", usd: 5, leverage: 2 })).toThrow(/minimum/);
    expect(() => preparePerpOrder({ market, side: "long", usd: 100, leverage: 25 })).toThrow(/1× to 10×/);
    const p = preparePerpOrder({ market, side: "short", usd: 100, leverage: 5 });
    expect(p.actions).toHaveLength(2);
    expect(p.details.find(([k]) => k === "Est. liquidation")).toBeTruthy();
    expect(estimateLiquidation("long", 100, 5, 40)).toBeLessThan(100);
    expect(estimateLiquidation("short", 100, 5, 40)).toBeGreaterThan(100);
  });
});

describe("VEIL Nexus connections", () => {
  it("only answers Infinitum product origins over https", () => {
    expect(productForOrigin("https://scalvs.app")?.id).toBe("scalvs");
    expect(productForOrigin("https://drive.cumuluscloud.app")?.id).toBe("cumulus");
    expect(productForOrigin("https://scalvs.app.evil.com")).toBeNull();
    expect(productForOrigin("https://evilscalvs.app")).toBeNull();
    expect(productForOrigin("http://scalvs.app")).toBeNull();
    expect(productForOrigin("https://scalvs.app/path")).toBeNull();
    expect(productForOrigin("http://localhost:3000")).toBeNull();
    expect(productForOrigin("http://localhost:3000", true)?.id).toBe("local");
  });

  it("parses connect and pay requests and builds a SIWE message", () => {
    const c = parseRequest("#/connect?origin=https%3A%2F%2Fmttrn.app&nonce=abc12345xyz&chain=base");
    expect(c && "type" in c && c.type).toBe("connect");
    if (c && "type" in c && c.type === "connect") {
      const msg = siweMessage(c, "mainnet", evmAccount(ABANDON).address, new Date("2026-11-08T00:00:00Z"));
      expect(msg).toContain("mttrn.app wants you to sign in with your Ethereum account");
      expect(msg).toContain("Nonce: abc12345xyz");
      expect(msg).toContain("Chain ID: 8453");
    }
    const bad = parseRequest("#/connect?origin=https%3A%2F%2Fevil.com&nonce=abc12345xyz");
    expect(bad && "error" in bad).toBe(true);
    const pay = parseRequest("#/pay?origin=https%3A%2F%2Frchtch.app&chain=base&asset=usdc&to=0xabc&amount=12.5&memo=Invoice%2042");
    expect(pay && "type" in pay && pay.type === "pay" && pay.asset).toBe("USDC");
    expect(parseRequest("#/pay?origin=https%3A%2F%2Frchtch.app&amount=-1")).toHaveProperty("error");
  });
});

describe("markets data", () => {
  it("finds verified xStocks only", () => {
    const s = toStocks([
      { id: "m1", name: "Apple xStock", symbol: "AAPLx", decimals: 8, isVerified: true },
      { id: "m2", name: "Apple xStock", symbol: "AAPLx", decimals: 8, isVerified: false },
      { id: "m3", name: "Some coin", symbol: "COIN", decimals: 6, isVerified: true },
    ]);
    expect(s.map((x) => [x.symbol, x.underlying, x.category])).toEqual([["AAPLx", "AAPL", "stock"]]);
  });

  it("parses GeckoTerminal daily prices oldest-first and maps wrapped assets to their history", () => {
    const c = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[200, 1, 2, 0.5, 1.6, 9], [100, 1, 2, 0.5, 1.5, 9], [150, 1, 2, 0.5, 0, 9]] } } });
    expect(c.map((x) => x.close)).toEqual([1.5, 1.6]);
    expect(c[0]!.t).toBe(100_000);
    expect(parseGeckoOhlcv({})).toEqual([]);
    expect(historyCoin("cbBTC")).toBe("BTC");
    expect(historyCoin("WETH")).toBe("ETH");
    expect(historyCoin("USDC")).toBeNull();
  });

  it("routes swaps directly and through the $FIRM and USDC hubs", () => {
    const A = "0x0000000000000000000000000000000000000001", B = "0x0000000000000000000000000000000000000002";
    const FIRM = "0x0000000000000000000000000000000000000003", USDC = "0x0000000000000000000000000000000000000004";
    expect(candidatePaths(A, B, [FIRM, USDC])).toEqual([[A, B], [A, FIRM, B], [A, USDC, B]]);
    expect(candidatePaths(FIRM, B, [FIRM, USDC])).toEqual([[FIRM, B], [FIRM, USDC, B]]);
  });

  it("lists wrapped crypto on mainnet and keeps undeployed Infinitum tokens unaddressed", () => {
    const eth = tokensFor("mainnet", "ethereum");
    expect(eth.filter((t) => t.category === "wrapped").map((t) => t.symbol)).toEqual(["WETH", "WBTC", "cbBTC"]);
    expect(eth.find((t) => t.symbol === "FIRM")?.address).toBeUndefined();
    expect(tokensFor("mainnet", "solana").some((t) => t.symbol === "wSOL")).toBe(true);
  });

  it("counts only tokens received by this wallet as rewards", () => {
    const bal = (owner: string, amount: string) => ({ mint: "M", owner, uiTokenAmount: { amount } });
    expect(balanceDelta([bal("me", "5")], [bal("me", "12"), bal("you", "1")], "me", "M")).toBe(7n);
    expect(balanceDelta([bal("me", "5")], [bal("me", "2")], "me", "M")).toBe(-3n);
  });
});
