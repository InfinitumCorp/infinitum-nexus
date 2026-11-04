/**
 * FABRIC session scaffold.
 * Tracks an encrypted conversation between two parties.
 */
import { createMessage, type FabricMessage } from "./message.ts";

export class FabricSession {
  private messages: FabricMessage[] = [];
  public a: string;
  public b: string;
  public key: string;

  constructor(a: string, b: string, key: string) {
    this.a = a;
    this.b = b;
    this.key = key;
  }

  send(from: string, to: string, plaintext: string): FabricMessage {
    const m = createMessage(from, to, plaintext, this.key);
    this.messages.push(m);
    return m;
  }

  history(): FabricMessage[] {
    return [...this.messages];
  }
}
