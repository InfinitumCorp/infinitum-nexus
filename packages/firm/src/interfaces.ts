/**
 * FIRM ecosystem token and wallet interfaces.
 * Concrete EVM implementations come later; these are the contracts the rest of the system uses.
 */

export interface FirmToken {
  symbol: "FIRM";
  name: "Firmament";
  decimals: 18;
  /** Total supply (string to avoid bigint issues in JSON). */
  totalSupply(): Promise<string>;
  balanceOf(owner: string): Promise<string>;
  transfer(to: string, amount: string): Promise<{ txHash: string }>;
}

export interface FirmWallet {
  address: string;
  /** Sign a message or transaction. */
  sign(payload: string): Promise<string>;
  /** Get FIRM balance. */
  balance(): Promise<string>;
}

export interface Settlement {
  /** Record a settlement on Firmament after an on-chain transfer. */
  record(from: string, to: string, amount: string, txHash: string): Promise<{ ledgerHash: string }>;
}
