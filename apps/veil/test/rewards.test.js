import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POLICY, emptyLedger, recordActivity, summarize, issueReceipt, buildClaim, formatVeil, dayKey,
} from "../lib/rewards.js";

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const human = (at) => ({ at, trusted: true, visible: true, focused: true });

test("matches the published launch rates", () => {
  assert.equal(formatVeil(POLICY.ratePerMinuteMicro), "0.100000");
  assert.equal(POLICY.maxMinutesPerDay, 240);
  assert.equal(formatVeil(POLICY.ratePerMinuteMicro * POLICY.maxMinutesPerDay), "24.000000");
});

test("credits one eligible minute once", () => {
  let { ledger, credited } = recordActivity(emptyLedger(), human(T0));
  assert.equal(credited, true);
  const again = recordActivity(ledger, human(T0 + 30_000));
  assert.equal(again.credited, false);
  assert.equal(again.reason, "already-credited");
  ledger = recordActivity(ledger, human(T0 + 60_000)).ledger;
  assert.equal(ledger.minutesToday, 2);
  assert.equal(formatVeil(ledger.pendingMicro), "0.200000");
});

test("synthetic, hidden or unfocused activity never earns", () => {
  for (const bad of [{ trusted: false }, { visible: false }, { focused: false }]) {
    const r = recordActivity(emptyLedger(), { ...human(T0), ...bad });
    assert.equal(r.credited, false);
    assert.equal(r.reason, "ineligible");
  }
});

test("stops at 240 minutes and resets on the next UTC day", () => {
  let ledger = emptyLedger();
  for (let m = 0; m < 300; m++) ledger = recordActivity(ledger, human(T0 + m * 60_000)).ledger;
  assert.equal(ledger.minutesToday, 240);
  assert.equal(formatVeil(ledger.lifetimeMicro), "24.000000");
  const capped = recordActivity(ledger, human(T0 + 301 * 60_000));
  assert.equal(capped.reason, "daily-limit");

  const tomorrow = Date.UTC(2026, 10, 7, 0, 5);
  const r = recordActivity(ledger, human(tomorrow));
  assert.equal(r.credited, true);
  assert.equal(r.ledger.minutesToday, 1);
  assert.equal(r.ledger.day, dayKey(tomorrow));
});

test("refuses activity from a clock that went backwards", () => {
  const { ledger } = recordActivity(emptyLedger(), human(T0));
  assert.equal(recordActivity(ledger, human(T0 - 120_000)).reason, "clock-skew");
});

test("summary shows zero for today after midnight", () => {
  const { ledger } = recordActivity(emptyLedger(), human(T0));
  assert.equal(summarize(ledger, T0).eligibleMinutesToday, 1);
  const next = summarize(ledger, Date.UTC(2026, 10, 7, 1));
  assert.equal(next.eligibleMinutesToday, 0);
  assert.equal(next.remainingMinutesToday, 240);
  assert.equal(next.pendingMicro, 100_000);
});

test("receipts move pending into a claim and need a CID", () => {
  const { ledger } = recordActivity(emptyLedger(), human(T0));
  assert.throws(() => issueReceipt(ledger, null, T0), /Cumulus:\/\/ID/);
  const { ledger: after, receipt } = issueReceipt(ledger, "cid_1", T0);
  assert.equal(receipt.amount, "0.100000");
  assert.equal(receipt.status, "pending-settlement");
  assert.equal(after.pendingMicro, 0);
  assert.equal(after.lifetimeMicro, 100_000);
  assert.equal(issueReceipt(after, "cid_1", T0).receipt, null);
});

test("claim call needs a deployed contract", () => {
  const { ledger } = recordActivity(emptyLedger(), human(T0));
  const { receipt } = issueReceipt(ledger, "cid_1", T0);
  assert.throws(() => buildClaim(receipt, ""), /not deployed/);
  const claim = buildClaim(receipt, "0xabc");
  assert.deepEqual(claim, { to: "0xabc", method: "claim", args: ["cid_1", "100000", receipt.id] });
});
