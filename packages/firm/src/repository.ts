/**
 * FIRM Wallet storage boundary (relational storage plan, phase 5). WalletAccounts reads and writes
 * only through this interface, one wallet or transfer at a time, with every change an explicit put,
 * so a database implementation (wallet_accounts, wallet_transfers) can replace the in-memory one.
 *
 * MapWalletRepository keeps today's WalletStore and its snapshot format exactly as they are.
 */
import type { WalletAccount, WalletStore, WalletTransfer } from "./accounts.ts";

export interface WalletRepository {
  account(cid: string): Promise<WalletAccount | undefined>;
  cidForAddress(address: string): Promise<string | undefined>;
  /** Insert or update; keeps the address index in step. */
  putAccount(account: WalletAccount): Promise<void>;
  /** Transfers to or from `cid`, newest first, at most `limit`. */
  transfersOf(cid: string, limit: number): Promise<WalletTransfer[]>;
  putTransfer(transfer: WalletTransfer): Promise<void>;
}

export class MapWalletRepository implements WalletRepository {
  readonly store: WalletStore;
  constructor(store: WalletStore) {
    this.store = store;
  }
  async account(cid: string) {
    return this.store.accounts.get(cid);
  }
  async cidForAddress(address: string) {
    return this.store.byAddress.get(address.toLowerCase());
  }
  async putAccount(account: WalletAccount) {
    this.store.accounts.set(account.cid, account);
    this.store.byAddress.set(account.address, account.cid);
  }
  async transfersOf(cid: string, limit: number) {
    return [...this.store.transfers.values()]
      .filter((t) => t.from === cid || t.to === cid)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);
  }
  async putTransfer(transfer: WalletTransfer) {
    this.store.transfers.set(transfer.id, transfer);
  }
}

/** Test double that behaves like a database: values are copied in and out, so nothing relies on mutation. */
export class CopyingWalletRepository implements WalletRepository {
  readonly #inner: MapWalletRepository;
  constructor(store: WalletStore) {
    this.#inner = new MapWalletRepository(store);
  }
  async account(cid: string) { return structuredClone(await this.#inner.account(cid)); }
  async cidForAddress(address: string) { return this.#inner.cidForAddress(address); }
  async putAccount(account: WalletAccount) { return this.#inner.putAccount(structuredClone(account)); }
  async transfersOf(cid: string, limit: number) { return structuredClone(await this.#inner.transfersOf(cid, limit)); }
  async putTransfer(transfer: WalletTransfer) { return this.#inner.putTransfer(structuredClone(transfer)); }
}
