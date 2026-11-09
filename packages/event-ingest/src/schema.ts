import { createHash } from "node:crypto";
import { LabyrinthError } from "@infinitum/lbrnth";
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface ArchiveEvent {id:string;kind:"archive"|"diagnostic";payload:Json;observedAt?:string}
export const ARCHIVE_PRODUCTS = ["daemon","slug","orbis","pollen","flower","spectre","architect","hrvst","cloud","cumulus-mail","fabric","eon","aether","scalvs","metatron","firm","tokens","firm-wallet","cumulus-exchange","firmament","conjure","veil","cumulus"] as const;
export const fail = (code:LabyrinthError["code"],message:string):never => {throw new LabyrinthError(code,message);};
export function identifier(value:unknown):string {
  if(typeof value!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))return fail("invalid","Invalid identifier");
  return value;
}
export function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))return fail("invalid","Expected object");
  return value as Record<string,unknown>;
}
export function exact(value:Record<string,unknown>,keys:string[]) {
  if(Object.keys(value).some(key=>!keys.includes(key)))fail("invalid","Unknown field");
}
export function productId(value:string):string {
  if(!(ARCHIVE_PRODUCTS as readonly string[]).includes(value))return fail("invalid","Unsupported archive product");return value;
}
/** Independent canonical JSON subset: no accessors, cycles, nonfinite numbers or exotic prototypes. */
export function canonical(value:unknown):string {
  let nodes=0;const visited=new Set<object>();
  function encode(v:unknown,depth:number):string {
    if(++nodes>2048||depth>8) return fail("invalid","JSON complexity limit");
    if(v===null||typeof v==="boolean")return JSON.stringify(v);
    if(typeof v==="number") {if(!Number.isFinite(v))return fail("invalid","Nonfinite number");return JSON.stringify(v);}
    if(typeof v==="string") {if(v.length>32768)return fail("invalid","String limit");return JSON.stringify(v);}
    if(!v||typeof v!=="object"||visited.has(v))return fail("invalid","Invalid JSON value");
    const proto=Object.getPrototypeOf(v);if(!Array.isArray(v)&&proto!==Object.prototype&&proto!==null)return fail("invalid","Invalid JSON prototype");
    visited.add(v);
    let encoded:string;
    if(Array.isArray(v)) {
      if(v.length>1024||Object.keys(v).length!==v.length||Object.getOwnPropertySymbols(v).length||Object.values(Object.getOwnPropertyDescriptors(v)).some(d=>!("value" in d)))return fail("invalid","Invalid array");
      encoded="["+v.map(child=>encode(child,depth+1)).join(",")+"]";
    } else {
      if(Object.getOwnPropertySymbols(v).length)return fail("invalid","Symbol JSON fields");
      const descriptors=Object.getOwnPropertyDescriptors(v),keys=Object.keys(descriptors).sort();
      if(keys.length>256)return fail("invalid","Object field limit");
      encoded="{"+keys.map(key=>{
        const d=descriptors[key]!;if(!d.enumerable||!("value" in d)||key.length>128)return fail("invalid","Invalid JSON field");
        return JSON.stringify(key)+":"+encode(d.value,depth+1);
      }).join(",")+"}";
    }
    visited.delete(v);return encoded;
  }
  const encoded=encode(value,0);if(Buffer.byteLength(encoded)>32768)return fail("invalid","Event exceeds 32 KiB");return encoded;
}
export function archiveEvent(value:unknown):ArchiveEvent {
  const row=object(value);exact(row,["id","kind","payload","observedAt"]);identifier(row.id);
  if(!Object.hasOwn(row,"payload"))return fail("invalid","Event payload required");
  if(row.kind!=="archive"&&row.kind!=="diagnostic")return fail("invalid","Only archival event kinds are supported");
  if(row.observedAt!==undefined&&(typeof row.observedAt!=="string"||!Number.isFinite(Date.parse(row.observedAt))||new Date(row.observedAt).toISOString()!==row.observedAt))return fail("invalid","Invalid observedAt");
  // Snapshot before invoking any asynchronous transport/dispatcher.
  return JSON.parse(canonical(row)) as ArchiveEvent;
}
export const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
