/** Selected historical observations only; never dispatches vehicle commands. */
import {archiveEvent,createArchiveClient} from "@infinitum/event-ingest";
import type {ArchiveClientOptions} from "@infinitum/event-ingest";
import {DRONE_PRODUCTS} from "./backend.ts";
import {decodeTelemetry} from "./mavlink.ts";
export function createDroneArchiveClient(product:keyof typeof DRONE_PRODUCTS,options:Omit<ArchiveClientOptions,"product">) {
  if(!Object.hasOwn(DRONE_PRODUCTS,product))throw new Error("Unknown drone archive product");
  return createArchiveClient({...options,product});
}
export function droneArchiveEvent(id:string,frames:Uint8Array) {
  return archiveEvent({id,kind:"archive",payload:{format:"selected-mavlink-observations",controlAuthority:false,senderVerified:false,observations:decodeTelemetry(frames)}});
}
