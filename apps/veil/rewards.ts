/**
 * VEIL rewards — claimable receipt + claim wiring.
 * Local accrual today. On-chain via VeilClaim.sol once deployed.
 */
export interface RewardReceipt {
  user: string;
  veil: string;
  seconds: number;
  at: string;
  claimable: boolean;
  receiptId?: string;
  proof?: string;
}

const RATE = 0.001;

export function accrue(user: string, seconds: number): RewardReceipt {
  const receipt = {
    user,
    seconds,
    veil: (seconds * RATE).toFixed(6),
    at: new Date().toISOString(),
    claimable: true,
  };
  receipt.receiptId = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join("");
  return receipt;
}

export function buildClaim(receipt: RewardReceipt, claimContract: string) {
  return {
    to: claimContract,
    method: "claim",
    args: [receipt.receiptId, receipt.veil],
    note: "Call VeilClaim.claim once the contract is funded and deployed",
  };
}
