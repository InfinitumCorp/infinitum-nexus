import { ID_CLIENTS } from "@infinitum/cid";

/**
 * Products whose Cumulus://ID access tokens may open Labyrinth through +SPCTR's directory (client mode): Infinitum's
 * own hosted products, as listed in packages/cid id-clients. Left out: tools that run on the person's own computer
 * (loopback), and products hosted outside Infinitum's domains that the issuer shows a consent page for (`node`), or
 * that +SPCTR doesn't know at all (the issuer's other third-party clients, e.g. `academy`).
 */
const EXCLUDED = new Set(["node"]);

export function labyrinthClient(clientId: string): boolean {
  const c = Object.prototype.hasOwnProperty.call(ID_CLIENTS, clientId) ? ID_CLIENTS[clientId] : undefined;
  return Boolean(c && !c.loopback && !EXCLUDED.has(clientId) && c.origins.length > 0);
}
