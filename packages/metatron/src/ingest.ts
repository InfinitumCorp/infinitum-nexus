/** Explicit server-side archival only; no automatic uploads or identity substitution. */
import {createArchiveClient} from "@infinitum/event-ingest";
import type {ArchiveClientOptions} from "@infinitum/event-ingest";
export function createMetatronArchiveClient(options:Omit<ArchiveClientOptions,"product">) {return createArchiveClient({...options,product:"metatron"});}
