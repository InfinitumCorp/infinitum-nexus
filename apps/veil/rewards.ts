/**
 * VEIL rewards — claimable receipt structure.
 * Local accrual today; on-chain settlement via Firmament + $VEIL token later.
 */
export interface RewardReceipt {
  user: string;
  veil: string;
  seconds: number;
  at: string;
  claimable: boolean;
  /** Placeholder for on-chain claim tx or Firmament proof. */
  proof?: string;
}

const RATE = 0.001;

export function accrue(user: string, seconds: number): RewardReceipt {
  return {
    user,
    seconds,
    veil: (seconds * RATE).toFixed(6),
    at: new Date().toISOString(),
    claimable: true,
  };
}

export function buildClaim(receipt: RewardReceipt, tokenAddress: string) {
  return {
    to: tokenAddress,
    method: "claim",
    args: [receipt.user, receipt.veil, receipt.at],
    note: "Submit via FIRM wallet once $VEIL is deployed",
  };
}
