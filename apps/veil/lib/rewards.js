/**
 * VEIL $VEIL rewards ledger.
 *
 * Implements the published launch policy:
 *   0.1 $VEIL per eligible active minute, at most 240 rewarded minutes
 *   (24 $VEIL) per UTC day. Rates change only going forward.
 *
 * A minute is eligible only when it contains a trusted (human) input event
 * on a visible, focused page. Nothing here records which site was visited:
 * the ledger holds counts and amounts only.
 *
 * Amounts are integers in micro-VEIL (1 $VEIL = 1,000,000 micro) so totals
 * never drift. Every function is pure and returns a new ledger.
 */

export const MICRO = 1_000_000;

export const POLICY = Object.freeze({
  version: "launch-1",
  ratePerMinuteMicro: 100_000, // 0.1 $VEIL
  maxMinutesPerDay: 240,
});

/** UTC calendar day, e.g. "2026-11-06". */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyLedger() {
  return {
    policy: POLICY.version,
    day: null,
    minutesToday: 0,
    lastMinute: null,
    pendingMicro: 0,
    lifetimeMicro: 0,
    receipts: [],
  };
}

/**
 * Record one activity signal.
 * @param {object} ledger
 * @param {{ at: number, trusted: boolean, visible: boolean, focused: boolean }} signal
 *   `at` must come from the extension's own clock, never from the page.
 * @returns {{ ledger: object, credited: boolean, reason: string }}
 */
export function recordActivity(ledger, signal) {
  const { at, trusted, visible, focused } = signal;
  if (!trusted || !visible || !focused) {
    return { ledger, credited: false, reason: "ineligible" };
  }
  const minute = Math.floor(at / 60_000);
  if (ledger.lastMinute !== null && minute < ledger.lastMinute) {
    return { ledger, credited: false, reason: "clock-skew" };
  }
  if (minute === ledger.lastMinute) {
    return { ledger, credited: false, reason: "already-credited" };
  }

  const day = dayKey(at);
  const minutesToday = day === ledger.day ? ledger.minutesToday : 0;
  if (minutesToday >= POLICY.maxMinutesPerDay) {
    return { ledger: { ...ledger, day, minutesToday }, credited: false, reason: "daily-limit" };
  }

  const next = {
    ...ledger,
    day,
    minutesToday: minutesToday + 1,
    lastMinute: minute,
    pendingMicro: ledger.pendingMicro + POLICY.ratePerMinuteMicro,
    lifetimeMicro: ledger.lifetimeMicro + POLICY.ratePerMinuteMicro,
  };
  return { ledger: next, credited: true, reason: "credited" };
}

/**
 * Dashboard view of the ledger at time `now`.
 */
export function summarize(ledger, now) {
  const minutesToday = ledger.day === dayKey(now) ? ledger.minutesToday : 0;
  return {
    eligibleMinutesToday: minutesToday,
    remainingMinutesToday: POLICY.maxMinutesPerDay - minutesToday,
    earnedTodayMicro: minutesToday * POLICY.ratePerMinuteMicro,
    dailyLimitMicro: POLICY.maxMinutesPerDay * POLICY.ratePerMinuteMicro,
    pendingMicro: ledger.pendingMicro,
    lifetimeMicro: ledger.lifetimeMicro,
    receipts: ledger.receipts.length,
  };
}

/**
 * Move everything pending into a claim receipt. Settlement on Firmament
 * Network happens later; until then a receipt is "pending-settlement".
 * @returns {{ ledger: object, receipt: object | null }}
 */
export function issueReceipt(ledger, user, now) {
  if (!user) throw new Error("A Cumulus://ID is required to claim rewards");
  if (ledger.pendingMicro <= 0) return { ledger, receipt: null };
  const receipt = {
    id: `veil-${now.toString(36)}-${ledger.receipts.length + 1}`,
    user,
    amountMicro: ledger.pendingMicro,
    amount: formatVeil(ledger.pendingMicro),
    policy: POLICY.version,
    issuedAt: new Date(now).toISOString(),
    status: "pending-settlement",
  };
  const next = {
    ...ledger,
    pendingMicro: 0,
    receipts: [...ledger.receipts, receipt].slice(-50),
  };
  return { ledger: next, receipt };
}

/**
 * Claim call for the $VEIL claim contract, to be signed in FIRM Wallet.
 */
export function buildClaim(receipt, contractAddress) {
  if (!contractAddress) throw new Error("$VEIL claim contract is not deployed yet");
  return {
    to: contractAddress,
    method: "claim",
    args: [receipt.user, String(receipt.amountMicro), receipt.id],
  };
}

/** 100000 -> "0.100000" */
export function formatVeil(micro) {
  const whole = Math.floor(micro / MICRO);
  const frac = String(micro % MICRO).padStart(6, "0");
  return `${whole}.${frac}`;
}
