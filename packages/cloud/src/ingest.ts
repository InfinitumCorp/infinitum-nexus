/** Explicit server-side archival only; no automatic uploads or identity substitution. */
import {createArchiveClient} from "@infinitum/event-ingest";
import type {ArchiveClientOptions} from "@infinitum/event-ingest";
export function createCloudArchiveClient(options:Omit<ArchiveClientOptions,"product">) {return createArchiveClient({...options,product:"cloud"});}
