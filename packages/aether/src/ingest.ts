/** Server-side archival of explicitly selected simulation/diagnostic artifacts only; no mesh routing. */
import {createArchiveClient} from "@infinitum/event-ingest";
import type {ArchiveClientOptions} from "@infinitum/event-ingest";
export function createAetherArchiveClient(options:Omit<ArchiveClientOptions,"product">) {return createArchiveClient({...options,product:"aether"});}
