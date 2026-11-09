import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CidLabyrinth, EncryptedFileStorage, MemoryStorage } from "@infinitum/lbrnth";
import { ArchiveIngest } from "./service.ts";
import { setup } from "./testing.ts";
const event = {id:"event-1", kind:"archive", payload:{size:42, label:"selected"}};
test("durable receipt, canonical idempotency and conflicting replay protection", async () => {
  const s=await setup(), ingest=new ArchiveIngest(s.auth);
  const first=ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,event);
  assert.equal(first.stored,true); assert.equal(first.duplicate,false); assert.equal(first.delivery,"pending");
  const duplicate=ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,{...event,payload:{label:"selected",size:42}});
  assert.equal(duplicate.contentHash,first.contentHash); assert.equal(duplicate.commitId,first.commitId); assert.equal(duplicate.duplicate,true);
  assert.throws(() => ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,{...event,payload:{size:43}}),/reused/);
  assert.ok(s.auth.forProduct(s.owner.token,"spectre").history(s.owner.repo)[0]!.tree["products/spectre/ingest/gateway/event-1.json"]);
});
test("dispatcher failure leaves durable pending event; explicit retry reports delivered only after completion", async () => {
  const s=await setup(); let fail=true, calls=0;
  const ingest=new ArchiveIngest(s.auth,{dispatcher:{send:async (_event,key,_signal) => {assert.match(key,/^[a-f0-9]{64}$/);calls++;if(fail)throw new Error("private downstream error");}}});
  ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event);
  const pending=await ingest.deliver(s.owner.token,"cloud","gateway",s.owner.repo,event.id);
  assert.equal(pending.delivery,"pending");assert.equal(pending.attempts,1);
  fail=false;const sent=await ingest.deliver(s.owner.token,"cloud","gateway",s.owner.repo,event.id);
  assert.equal(sent.delivery,"delivered");assert.equal(sent.attempts,2);
  await ingest.deliver(s.owner.token,"cloud","gateway",s.owner.repo,event.id);assert.equal(calls,2);
});
test("restart reconstructs idempotency and pending outbox from encrypted storage, not RAM", async () => {
  const dir=mkdtempSync(join(tmpdir(),"ingest-test-")); const file=join(dir,"archive.json"); const key=Buffer.alloc(32,9);
  try {
    const s=await setup(new EncryptedFileStorage(file,()=>key));
    const first=new ArchiveIngest(s.auth).submit(s.owner.token,"hrvst","gateway",s.owner.repo,event);
    const restarted=new CidLabyrinth(s.cid,{...s.options,storage:new EncryptedFileStorage(file,()=>key)});
    const next=new ArchiveIngest(restarted,{dispatcher:{send:async () => {}}});
    assert.equal(next.submit(s.owner.token,"hrvst","gateway",s.owner.repo,event).commitId,first.commitId);
    assert.equal((await next.deliver(s.owner.token,"hrvst","gateway",s.owner.repo,event.id)).delivery,"delivered");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("uncommitted storage failure cannot return an acknowledgement or dispatch", async () => {
  const memory=new MemoryStorage();let fail=false,calls=0;
  const s=await setup({load:()=>memory.load(),save:orgs=>{if(fail)throw new Error("disk unavailable");memory.save(orgs);}});
  const ingest=new ArchiveIngest(s.auth,{dispatcher:{send:async()=>{calls++;}}});fail=true;
  assert.throws(()=>ingest.submit(s.owner.token,"fabric","gateway",s.owner.repo,event));assert.equal(calls,0);
});
test("CID session/plan/consent revocation applies to duplicates, reads and dispatcher side effects", async () => {
  const s=await setup();let calls=0;const ingest=new ArchiveIngest(s.auth,{dispatcher:{send:async()=>{calls++;}}});
  ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,event);
  s.setPaid(false);assert.throws(()=>ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,event));s.setPaid(true);
  await s.cid.revoke(s.owner.account.cid,"LBRNTH");await s.cid.grant(s.owner.account.cid,"LBRNTH",["repo:read"]);
  await assert.rejects(ingest.deliver(s.owner.token,"spectre","gateway",s.owner.repo,event.id));assert.equal(calls,0);
  await s.cid.revokeSession(s.owner.account.cid,s.owner.session.id);
  assert.throws(()=>ingest.receipt(s.owner.token,"spectre","gateway",s.owner.repo,event.id));
});
test("per-source/product/org isolation and absent dispatcher fail closed", async () => {
  const s=await setup(), ingest=new ArchiveIngest(s.auth);
  ingest.submit(s.owner.token,"daemon","gateway",s.owner.repo,event);
  assert.throws(()=>ingest.receipt(s.owner.token,"daemon","other",s.owner.repo,event.id));
  assert.throws(()=>ingest.receipt(s.owner.token,"flower","gateway",s.owner.repo,event.id));
  const other=await s.login();assert.throws(()=>ingest.receipt(other.token,"daemon","gateway",s.owner.repo,event.id));
  await assert.rejects(ingest.deliver(s.owner.token,"daemon","gateway",s.owner.repo,event.id),/dispatcher/);
});
test("bounded schemas reject nonfinite/oversize/deep/cyclic data and command-like event kinds", async () => {
  const s=await setup(), ingest=new ArchiveIngest(s.auth);const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  let deep:unknown={};for(let i=0;i<10;i++)deep={inner:deep};
  for(const value of [{...event,payload:{n:NaN}},{...event,payload:{text:"x".repeat(33000)}},{...event,payload:deep},{...event,payload:cyclic},{...event,kind:"command"},{...event,id:"../escape"},{...event,orgId:"victim"}]) assert.throws(()=>ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,value));
});
test("finite retry budget and in-process concurrent-dispatch exclusion", async () => {
  const s=await setup();let release:()=>void=()=>{};const waiting=new Promise<void>(r=>{release=r;});let calls=0;
  const ingest=new ArchiveIngest(s.auth,{maxAttempts:1,dispatcher:{send:async()=>{calls++;await waiting;throw new Error("failed");}}});
  ingest.submit(s.owner.token,"flower","gateway",s.owner.repo,event);
  const first=ingest.deliver(s.owner.token,"flower","gateway",s.owner.repo,event.id);
  await assert.rejects(ingest.deliver(s.owner.token,"flower","gateway",s.owner.repo,event.id),/active/);release();await first;
  await assert.rejects(ingest.deliver(s.owner.token,"flower","gateway",s.owner.repo,event.id),/budget/);assert.equal(calls,1);
});

test("source record cap preserves duplicate receipts but rejects new identifiers",async()=>{
  const s=await setup(),ingest=new ArchiveIngest(s.auth,{maxRecords:1});
  ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event);
  assert.equal(ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event).duplicate,true);
  assert.throws(()=>ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,{...event,id:"event-2"}),/capacity/);
});
test("cooperative dispatcher deadline leaves a retryable pending receipt",async()=>{
  const s=await setup();let aborted=false;
  const ingest=new ArchiveIngest(s.auth,{deliveryTimeoutMs:10,dispatcher:{send:async(_e,_k,signal)=>new Promise<void>((_resolve,reject)=>{signal.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));},{once:true});})}});
  ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event);
  const result=await ingest.deliver(s.owner.token,"cloud","gateway",s.owner.repo,event.id);
  assert.equal(aborted,true);assert.equal(result.delivery,"pending");assert.equal(result.attempts,1);
});
test("revocation while dispatcher awaits prevents false delivered marks",async()=>{
  const s=await setup();const ingest=new ArchiveIngest(s.auth,{dispatcher:{send:async()=>{s.setPaid(false);}}});
  ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event);
  await assert.rejects(ingest.deliver(s.owner.token,"cloud","gateway",s.owner.repo,event.id));
  s.setPaid(true);assert.equal(ingest.receipt(s.owner.token,"cloud","gateway",s.owner.repo,event.id).delivery,"pending");
});
test("receipt validation rejects a changed payload whose recorded hash was not updated",async()=>{
  const s=await setup(),ingest=new ArchiveIngest(s.auth);const first=ingest.submit(s.owner.token,"cloud","gateway",s.owner.repo,event);
  const client=s.auth.forProduct(s.owner.token,"cloud"),path="ingest/gateway/event-1.json";
  const row=JSON.parse(Buffer.from(client.load(s.owner.repo,first.commitId,path)).toString());row.event.payload={tampered:true};
  client.save(s.owner.repo,path,JSON.stringify(row),first.commitId);
  assert.throws(()=>ingest.receipt(s.owner.token,"cloud","gateway",s.owner.repo,event.id),/integrity/);
});
