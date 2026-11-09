/** Generic archival transport. Independent TLS/middleware implementation; source-pattern notices in ../NOTICE. */
import { createServer,request } from "node:https";
import type { ServerOptions } from "node:https";
import { TLSSocket } from "node:tls";
import type { IncomingMessage,ServerResponse } from "node:http";
import { LabyrinthError } from "@infinitum/lbrnth";
import { ArchiveIngest } from "./service.ts";
import type { Receipt } from "./service.ts";
import { archiveEvent,exact,identifier,object,productId } from "./schema.ts";
import type { ArchiveEvent } from "./schema.ts";
import { TokenBucket } from "./metrics.ts";
export interface PeerBinding {fingerprint256:string;source:string;repositories:Record<string,string>}
type Credentials=Required<Pick<ServerOptions,"key"|"cert"|"ca">>;
export interface GatewayOptions extends Credentials {peers:PeerBinding[];isPeerEnabled?:(fingerprint:string)=>boolean;requestsPerSecond?:number;burst?:number}
class HttpError extends Error {status:number;constructor(status:number){super("Request denied");this.status=status;}}
function fingerprint(value:string){const normalized=value.replaceAll(":","").toUpperCase();if(!/^[A-F0-9]{64}$/.test(normalized))throw new Error("Invalid certificate fingerprint");return normalized;}
async function body(req:IncomingMessage) {
  const chunks:Buffer[]=[];let bytes=0;
  const declared=req.headers["content-length"];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>65536))throw new HttpError(413);
  for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>65536)throw new HttpError(413);chunks.push(Buffer.from(chunk));}
  return object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))));
}
export function createArchiveServer(ingest:ArchiveIngest,options:GatewayOptions) {
  if(!options.key||!options.cert||!options.ca||!Array.isArray(options.peers)||!options.peers.length||options.peers.length>128)throw new Error("TLS credentials, trust roots and bounded peers required");
  const peers=new Map<string,{source:string;repositories:Map<string,string>;bucket:TokenBucket}>();
  for(const peer of options.peers){
    const fp=fingerprint(peer.fingerprint256);if(peers.has(fp))throw new Error("Duplicate peer fingerprint");
    const rows=Object.entries(peer.repositories);if(!rows.length||rows.length>32)throw new Error("Invalid repository bindings");
    peers.set(fp,{source:identifier(peer.source),repositories:new Map(rows.map(([product,repo])=>[productId(product),identifier(repo)])),bucket:new TokenBucket(options.requestsPerSecond??5,options.burst??10)});
  }
  let active=0;
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    const started=performance.now();let status=500;
    const respond=(code:number,data:unknown)=>{status=code;res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff",connection:"close"});res.end(JSON.stringify(data));};
    let admitted=false;
    try {
      if(active>=32)throw new HttpError(429);active++;admitted=true;
      if(!(req.socket instanceof TLSSocket)||!req.socket.authorized)throw new HttpError(403);
      const certificate=req.socket.getPeerCertificate();if(!certificate.fingerprint256)throw new HttpError(403);
      const fp=fingerprint(certificate.fingerprint256),peer=peers.get(fp);
      if(!peer||(options.isPeerEnabled&&options.isPeerEnabled(fp)!==true))throw new HttpError(403);
      if(!peer.bucket.take()){ingest.metrics.count("rate_limited");throw new HttpError(429);}
      const match=/^\/api\/archive-ingest\/([a-z0-9-]+)$/.exec(req.url??"");if(!match)throw new HttpError(404);
      const product=match[1]!,repo=peer.repositories.get(product);if(!repo)throw new HttpError(403);
      if(req.method!=="POST")throw new HttpError(405);
      if(req.headers.origin)throw new HttpError(403);
      if(req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase()!=="application/json"||req.headers["content-encoding"])throw new HttpError(415);
      const bearer=/^Bearer ([^\s]{1,512})$/.exec(req.headers.authorization??"");if(!bearer)throw new HttpError(401);
      const data=await body(req);let receipt:Receipt;
      if(data.action==="submit") {exact(data,["action","event"]);receipt=ingest.submit(bearer[1]!,product,peer.source,repo,data.event);}
      else if(data.action==="receipt") {exact(data,["action","id"]);receipt=ingest.receipt(bearer[1]!,product,peer.source,repo,identifier(data.id));}
      else if(data.action==="deliver") {exact(data,["action","id"]);receipt=await ingest.deliver(bearer[1]!,product,peer.source,repo,identifier(data.id));}
      else throw new HttpError(400);
      respond(data.action==="deliver"&&receipt.delivery==="pending"?202:200,receipt);
    }catch(error){
      const code=error instanceof HttpError?error.status:error instanceof LabyrinthError?({forbidden:403,not_found:404,invalid:400,conflict:409,integrity:500,capacity:429} as const)[error.code]:error instanceof SyntaxError||error instanceof TypeError?400:500;
      if(!res.headersSent)respond(code,{error:code>=500?"unavailable":"request_denied"});else res.destroy();
    }finally{if(admitted)active--;ingest.metrics.count(status<400?"http_2xx":status<500?"http_4xx":"http_5xx");ingest.metrics.duration(performance.now()-started);}
  };
  // Do not spread arbitrary TLS options: callers cannot override mandatory certificate verification.
  const server=createServer({key:options.key,cert:options.cert,ca:options.ca,requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3",maxHeaderSize:8192},(req,res)=>{void handler(req,res);});
  server.maxConnections=64;server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;
  server.setTimeout(15000,socket=>socket.destroy());return server;
}
export interface ArchiveClientOptions extends Credentials {origin:string;product:string;token:()=>string|Promise<string>}
/** Node-only mTLS client: never disables hostname verification or follows redirects. */
export function createArchiveClient(options:ArchiveClientOptions) {
  const url=new URL(options.origin),product=productId(options.product);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("HTTPS origin required");
  if(!options.key||!options.cert||!options.ca)throw new Error("Client mTLS credentials required");
  const endpoint=new URL(`/api/archive-ingest/${product}`,url);
  const send=async(data:unknown):Promise<Receipt>=>{
    const token=await options.token();if(!/^[^\s]{1,512}$/.test(token))throw new Error("CID bearer required");
    const bytes=Buffer.from(JSON.stringify(data));if(bytes.length>65536)throw new Error("Request too large");
    return new Promise((resolve,reject)=>{
      const req=request(endpoint,{method:"POST",agent:false,key:options.key,cert:options.cert,ca:options.ca,rejectUnauthorized:true,minVersion:"TLSv1.3",signal:AbortSignal.timeout(10000),headers:{"content-type":"application/json","content-length":String(bytes.length),authorization:`Bearer ${token}`}},res=>{
        const chunks:Buffer[]=[];let length=0;
        res.on("data",chunk=>{length+=Buffer.byteLength(chunk);if(length>65536){res.destroy(new Error("Response too large"));return;}chunks.push(Buffer.from(chunk));});
        res.on("error",reject);res.on("end",()=>{
          if(res.statusCode!==200&&res.statusCode!==202){reject(new Error(`Archive gateway denied (${res.statusCode})`));return;}
          try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Receipt);}catch{reject(new Error("Invalid archive response"));}
        });
      });req.on("error",reject);req.end(bytes);
    });
  };
  return {product,submit:(event:ArchiveEvent)=>send({action:"submit",event:archiveEvent(event)}),receipt:(id:string)=>send({action:"receipt",id:identifier(id)}),deliver:(id:string)=>send({action:"deliver",id:identifier(id)})};
}
