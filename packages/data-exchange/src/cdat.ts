import type { Ledger, Signer } from "@infinitum/firmament";

/**
 * Off-chain CDAT license token.
 * Mirrors packages/firm/contracts/CdatLicense.sol: one soulbound license per sale.
 * When a Firmament ledger is attached, issuance writes a "license" record and a "payment" record.
 */
export interface CdatToken {
  tokenId: string;
  /** Monotonic id matching the on-chain nextId sequence (starts at 1). */
  onchainId: number;
  datasetId: string;
  saleId: string;
  licensee: string;
  ownerCid: string;
  terms: string;
  amountUsd: number;
  amountUsdCents: number;
  issuedAt: string;
  expiresAt: string;
  burned: boolean;
  /** 0x address that will own the on-chain token. Absent until the buyer has a wallet. */
  licenseeAddress?: string;
  firmamentTx?: string;
  paymentTx?: string;
}

export interface CdatMintIntent {
  contract: "CdatLicense";
  function: "mint";
  args: {
    licensee: string;
    datasetId: string;
    terms: string;
    expiresAt: number;
    amountUsdCents: number;
  };
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** CDAT-commercial-1y, CDAT-research-30d, or a bare "1y" / "30d". Default 1 year. */
export function termDurationMs(terms: string): number {
  const match = terms.match(/(\d+)\s*(y|d)\b/i);
  if (!match) return YEAR_MS;
  const n = Number(match[1]);
  return match[2].toLowerCase() === "d" ? n * DAY_MS : n * YEAR_MS;
}

export class CdatIssuer {
  private tokens = new Map<string, CdatToken>();
  private nextOnchainId = 1;
  private ledger?: Ledger;
  private signer?: Signer;
  changed?: () => void;

  constructor(ledger?: Ledger, signer?: Signer) {
    this.ledger = ledger;
    this.signer = signer;
  }

  async issue(params: {
    datasetId: string;
    saleId: string;
    licensee: string;
    ownerCid: string;
    terms: string;
    amountUsd: number;
    userShareUsd: number;
    platformShareUsd: number;
    licenseeAddress?: string;
  }): Promise<CdatToken> {
    const onchainId = this.nextOnchainId;
    const tokenId = `cdat_${onchainId}`;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + termDurationMs(params.terms));
    const amountUsdCents = Math.round(params.amountUsd * 100);

    const token: CdatToken = {
      tokenId,
      onchainId,
      datasetId: params.datasetId,
      saleId: params.saleId,
      licensee: params.licensee,
      ownerCid: params.ownerCid,
      terms: params.terms,
      amountUsd: params.amountUsd,
      amountUsdCents,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      burned: false,
      licenseeAddress: params.licenseeAddress,
    };

    if (this.ledger && this.signer) {
      const license = await this.ledger.append(
        {
          type: "license",
          product: "data-exchange",
          actor: params.licensee,
          subject: params.datasetId,
          payload: {
            tokenId,
            onchainId,
            saleId: params.saleId,
            ownerCid: params.ownerCid,
            terms: params.terms,
            expiresAt: token.expiresAt,
            amountUsdCents,
          },
        },
        this.signer,
      );
      token.firmamentTx = license.hash;

      const payment = await this.ledger.append(
        {
          type: "payment",
          product: "data-exchange",
          actor: params.licensee,
          subject: params.saleId,
          payload: {
            tokenId,
            datasetId: params.datasetId,
            ownerCid: params.ownerCid,
            amountUsd: params.amountUsd,
            userShareUsd: params.userShareUsd,
            platformShareUsd: params.platformShareUsd,
          },
        },
        this.signer,
      );
      token.paymentTx = payment.hash;
    }

    this.nextOnchainId = onchainId + 1;
    this.tokens.set(tokenId, token);
    this.changed?.();
    return token;
  }

  mintIntent(token: CdatToken, licenseeAddress?: string): CdatMintIntent | null {
    const licensee = licenseeAddress
      ?? token.licenseeAddress
      ?? (isAddress(token.licensee) ? token.licensee : undefined);
    if (!licensee || !isAddress(licensee)) return null;
    return {
      contract: "CdatLicense",
      function: "mint",
      args: {
        licensee,
        datasetId: token.datasetId,
        terms: token.terms,
        expiresAt: Math.floor(Date.parse(token.expiresAt) / 1000),
        amountUsdCents: token.amountUsdCents,
      },
    };
  }

  async burn(tokenId: string): Promise<boolean> {
    const token = this.tokens.get(tokenId);
    if (!token || token.burned) return false;
    token.burned = true;
    this.changed?.();
    if (this.ledger && this.signer) {
      await this.ledger.append(
        {
          type: "revoke",
          product: "data-exchange",
          actor: token.ownerCid,
          subject: token.datasetId,
          payload: { tokenId, burned: true, saleId: token.saleId },
        },
        this.signer,
      );
    }
    return true;
  }

  get(tokenId: string): CdatToken | undefined {
    return this.tokens.get(tokenId);
  }

  isActive(tokenId: string, now = Date.now()): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.burned) return false;
    return Date.parse(token.expiresAt) > now;
  }

  list(): CdatToken[] {
    return [...this.tokens.values()];
  }

  listForDataset(datasetId: string): CdatToken[] {
    return this.list().filter((t) => t.datasetId === datasetId);
  }

  exportState(): { tokens: CdatToken[]; nextOnchainId: number } {
    return { tokens: this.list(), nextOnchainId: this.nextOnchainId };
  }

  importState(state: { tokens: CdatToken[]; nextOnchainId: number }) {
    this.tokens = new Map(state.tokens.map((t) => [t.tokenId, t]));
    this.nextOnchainId = state.nextOnchainId;
  }
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
