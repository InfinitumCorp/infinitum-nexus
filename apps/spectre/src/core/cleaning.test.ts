import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, MemoryStore, generateSigner } from "@infinitum/firmament";
import { SpectreCRM } from "./crm.ts";
import { findCompanyDuplicates, mergeCompanies } from "./cleaning.ts";

test("findCompanyDuplicates groups by domain", async () => {
  const crm = new SpectreCRM({ ledger: new Ledger(new MemoryStore()), signer: generateSigner() });
  const ws = "demo";
  await crm.addCompany(ws, "cid:u", { name: "Acme", domain: "acme.com" });
  await crm.addCompany(ws, "cid:u", { name: "Acme Inc", domain: "acme.com" });
  const groups = findCompanyDuplicates(crm, ws);
  assert.ok(groups.length > 0);
  assert.equal(groups[0].reason, "same domain");
});

test("mergeCompanies records merge", async () => {
  const crm = new SpectreCRM({ ledger: new Ledger(new MemoryStore()), signer: generateSigner() });
  const ws = "demo";
  const a = await crm.addCompany(ws, "cid:u", { name: "Acme", domain: "acme.com" });
  const b = await crm.addCompany(ws, "cid:u", { name: "Acme Inc", domain: "acme.com" });
  await mergeCompanies(crm, ws, "cid:u", a.id, [b.id]);
  assert.equal(crm.list("companies", ws).length, 1);
});
