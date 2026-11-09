import { createSocket } from "node:dgram";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { veilFixture } from "../../veil/server/testing.ts";
import { wireGuardKeyPair } from "../../veil/server/wireguard.ts";

const dir = process.argv[2];
if (!dir) throw new Error("fixture directory is required");

const port = await new Promise<number>((resolve, reject) => {
  const socket = createSocket("udp4");
  socket.once("error", reject);
  socket.bind(0, "127.0.0.1", () => {
    const bound = socket.address();
    socket.close();
    resolve(typeof bound === "string" ? 0 : bound.port);
  });
});
if (!port) throw new Error("could not reserve a UDP port");

const server = wireGuardKeyPair();
const fx = await veilFixture(undefined, undefined, {
  publicKey: server.publicKey,
  host: "127.0.0.1",
  port,
  exitToken: "exit-token-value1",
});
const user = await fx.login(true);
const grant = fx.control.connectDevice(user.token, "iad-1");
mkdirSync(dir, { recursive: true });
const clientPath = join(dir, "client.json");
const serverPath = join(dir, "server.json");
writeFileSync(clientPath, JSON.stringify(grant));
writeFileSync(serverPath, JSON.stringify({
  privateKey: server.privateKey,
  listenPort: port,
  peerPublicKey: grant.interface.publicKey,
  peerAddress: grant.interface.address,
}));
chmodSync(clientPath, 0o600);
chmodSync(serverPath, 0o600);
process.stdout.write(`${dir}\n`);
