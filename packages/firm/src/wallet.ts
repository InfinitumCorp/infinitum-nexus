/**
 * FIRM wallet signing.
 * Scaffold uses Node crypto for message signing.
 * Production EVM would use secp256k1 (ethers/viem) and produce recoverable signatures.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, createPrivateKey } from "node:crypto";
import type { FirmWallet } from "./interfaces.ts";
import { getBalance, type RpcClient } from "./evm-client.ts";

export interface FirmWalletOptions {
  address: string;
  /** PEM-encoded private key, or omit to generate a new one. */
  privateKeyPem?: string;
  client?: RpcClient;
  chainId?: number;
}

export interface SignedMessage {
  message: string;
  signature: string;
  address: string;
}

export class FirmWalletImpl implements FirmWallet {
  readonly address: string;
  readonly chainId: number;
  private readonly privateKeyPem: string;
  private readonly client?: RpcClient;

  constructor(opts: FirmWalletOptions) {
    this.address = opts.address;
    this.chainId = opts.chainId ?? 1;
    if (opts.privateKeyPem) {
      this.privateKeyPem = opts.privateKeyPem;
    } else {
      const { privateKey } = generateKeyPairSync("ed25519");
      this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    }
    this.client = opts.client;
  }

  async sign(payload: string): Promise<string> {
    const key = createPrivateKey(this.privateKeyPem);
    const sig = cryptoSign(null, Buffer.from(payload), key);
    return sig.toString("hex");
  }

  async signMessage(message: string): Promise<SignedMessage> {
    const prefixed = `\x19Ethereum Signed Message:\n${message.length}${message}`;
    const hash = createHash("sha256").update(prefixed).digest();
    const signature = await this.sign(hash.toString("hex"));
    return { message, signature, address: this.address };
  }

  async balance(): Promise<string> {
    if (!this.client) return "0";
    return getBalance(this.client, this.address);
  }

  /** Build an unsigned transfer payload (signing is external for now). */
  buildTransfer(to: string, amount: string, tokenAddress: string) {
    return {
      from: this.address,
      to: tokenAddress,
      data: {
        method: "transfer",
        args: [to, amount],
      },
      chainId: this.chainId,
    };
  }
}

export function createFirmWallet(opts: FirmWalletOptions): FirmWalletImpl {
  return new FirmWalletImpl(opts);
}
