/** Independent TS archival outbox informed by Tesla fleet-telemetry Producer/reliable-ack boundaries.
 * Storage and delivery acknowledgements are deliberately distinct. See ../NOTICE.
 */
import { CidLabyrinth } from "@infinitum/lbrnth";
import { archiveEvent, canonical, digest, exact, fail, identifier, object, productId } from "./schema.ts";
import type { ArchiveEvent } from "./schema.ts";
import { IngestMetrics } from "./metrics.ts";
export interface Dispatcher {send(event:ArchiveEvent,idempotencyKey:string,signal:AbortSignal):Promise<void>}
export interface Receipt {eventId:string;stored:true;contentHash:string;commitId:string;duplicate:boolean;delivery:"pending"|"delivered";attempts:number}
interface Stored {schema:1;product:string;source:string;event:ArchiveEvent;contentHash:string;delivery:"pending"|"delivered";attempts:number;createdAt:string}
export interface IngestOptions {dispatcher?:Dispatcher;metrics?:IngestMetrics;maxAttempts?:number;maxRecords?:number;deliveryTimeoutMs?:number}
export class ArchiveIngest {
  readonly #auth:CidLabyrinth;readonly #dispatcher?:Dispatcher;readonly metrics:IngestMetrics;
  readonly #attempts:number;readonly #records:number;readonly #timeout:number;readonly #active=new Set<string>();
  constructor(auth:CidLabyrinth,options:IngestOptions={}) {
    this.#auth=auth;this.#dispatcher=options.dispatcher;this.metrics=options.metrics??new IngestMetrics();
    this.#attempts=options.maxAttempts??5;this.#records=options.maxRecords??128;this.#timeout=options.deliveryTimeoutMs??10000;
    if(!Number.isInteger(this.#attempts)||this.#attempts<1||this.#attempts>10||!Number.isInteger(this.#records)||this.#records<1||this.#records>128||!Number.isInteger(this.#timeout)||this.#timeout<10||this.#timeout>30000)throw new Error("Invalid ingestion limits");
  }
  #context(token:string,product:string,source:string,repo:string) {
    productId(product);identifier(source);identifier(repo);
    const client=this.#auth.forProduct(token,product);client.repositories();
    return {client,path:(id:string)=>`ingest/${source}/${identifier(id)}.json`,prefix:`products/${product}/ingest/${source}/`};
  }
  #stored(raw:Uint8Array,product:string,source:string,id:string):Stored {
    try {
      const row=object(JSON.parse(Buffer.from(raw).toString("utf8")));
      exact(row,["schema","product","source","event","contentHash","delivery","attempts","createdAt"]);
      const event=archiveEvent(row.event);
      if(row.schema!==1||row.product!==product||row.source!==source||event.id!==id||row.contentHash!==digest({product,source,event})||!["pending","delivered"].includes(String(row.delivery))||!Number.isInteger(row.attempts)||Number(row.attempts)<0||Number(row.attempts)>10||typeof row.createdAt!=="string")throw new Error("Invalid receipt");
      return row as unknown as Stored;
    }catch{return fail("integrity","Stored receipt integrity failure");}
  }
  #receipt(row:Stored,commitId:string,duplicate:boolean):Receipt{return {eventId:row.event.id,stored:true,contentHash:row.contentHash,commitId,duplicate,delivery:row.delivery,attempts:row.attempts};}
  submit(token:string,product:string,source:string,repo:string,input:unknown):Receipt {
    const {client,path,prefix}=this.#context(token,product,source,repo),event=archiveEvent(input),contentHash=digest({product,source,event});
    const latest=client.history(repo,"main",1)[0],key=`products/${product}/${path(event.id)}`;
    if(latest&&Object.hasOwn(latest.tree,key)) {
      const existing=this.#stored(client.load(repo,latest.id,path(event.id)),product,source,event.id);
      if(existing.contentHash!==contentHash)return fail("conflict","Event id reused with different content");
      this.metrics.count("duplicate");return this.#receipt(existing,latest.id,true);
    }
    if(latest&&Object.keys(latest.tree).filter(p=>p.startsWith(prefix)).length>=this.#records)return fail("capacity","Archive source record capacity reached");
    const row:Stored={schema:1,product,source,event,contentHash,delivery:"pending",attempts:0,createdAt:new Date().toISOString()};
    const commit=client.save(repo,path(event.id),canonical(row),latest?.id??null,"Store selected archival event");
    this.metrics.count("stored");return this.#receipt(row,commit.id,false);
  }
  receipt(token:string,product:string,source:string,repo:string,id:string):Receipt {
    const {client,path}=this.#context(token,product,source,repo),latest=client.history(repo,"main",1)[0];
    if(!latest)return fail("not_found","Receipt not found");
    const row=this.#stored(client.load(repo,latest.id,path(id)),product,source,id);
    return this.#receipt(row,latest.id,true);
  }
  async deliver(token:string,product:string,source:string,repo:string,id:string):Promise<Receipt> {
    const {client,path}=this.#context(token,product,source,repo);identifier(id);
    if(!this.#dispatcher)return fail("invalid","No dispatcher configured");
    const lock=`${repo}/${product}/${source}/${id}`;
    if(this.#active.has(lock))return fail("conflict","Delivery already active");
    if(this.#active.size>=32)return fail("capacity","Delivery concurrency limit");
    this.#active.add(lock);
    try {
      let latest=client.history(repo,"main",1)[0];if(!latest)return fail("not_found","Receipt not found");
      const row=this.#stored(client.load(repo,latest.id,path(id)),product,source,id);
      if(row.delivery==="delivered")return this.#receipt(row,latest.id,true);
      if(row.attempts>=this.#attempts)return fail("capacity","Delivery attempt budget exhausted");
      row.attempts++;
      // Persist attempt before any downstream effect: enforces write consent/role/plan, not just reads.
      const attempt=client.save(repo,path(id),canonical(row),latest.id,"Record archive delivery attempt");
      this.metrics.count("dispatch_attempt");
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("Dispatch deadline"));},this.#timeout);});
      try {await Promise.race([this.#dispatcher.send(structuredClone(row.event),digest({repo,product,source,id}),controller.signal),timeout]);}
      catch {this.metrics.count("dispatch_failed");return this.#receipt(row,attempt.id,false);}
      finally {clearTimeout(timer);}
      // Reauthenticate after await; if revoked, no false delivered mark. Retry may duplicate downstream.
      latest=client.history(repo,"main",1)[0];if(!latest)return fail("not_found","Receipt disappeared");
      const current=this.#stored(client.load(repo,latest.id,path(id)),product,source,id);
      if(current.contentHash!==row.contentHash)return fail("conflict","Receipt changed during delivery");
      current.delivery="delivered";
      const committed=client.save(repo,path(id),canonical(current),latest.id,"Acknowledge archive dispatcher delivery");
      this.metrics.count("delivered");return this.#receipt(current,committed.id,false);
    } finally {this.#active.delete(lock);}
  }
}
