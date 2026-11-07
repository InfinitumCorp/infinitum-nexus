import {test} from "node:test";
import assert from "node:assert/strict";
import {djiDiagnosticEvent,mqttArchiveDispatcher,httpArchiveDispatcher} from "./adapters.ts";
import {IngestMetrics,TokenBucket} from "./metrics.ts";
import {ArchiveIngest} from "./service.ts";
import {setup} from "./testing.ts";
const raw=(data:unknown)=>Buffer.from(JSON.stringify({tid:"transaction-1",bid:"batch-1",timestamp:1794029400000,data}));
test("offline DJI-compatible OSD diagnostics retain known fields and discard position/control data",()=>{
  const event=djiDiagnosticEvent("thing/product/DOCK1/osd",raw({temperature:35,humidity:50,drone_in_dock:true,latitude:55,longitude:37,target:{x:1},flighttask_step_code:2}),"DOCK1");
  assert.equal(event.kind,"diagnostic");assert.match(event.id,/^[a-f0-9]{64}$/);
  const data=JSON.stringify(event);assert.ok(data.includes("temperatureC"));for(const field of ["latitude","longitude","target","flighttask"])assert.ok(!data.includes(field));
});
test("diagnostic adapter refuses source mismatch, command topics, invalid ranges and payloads",()=>{
  for(const topic of ["thing/product/OTHER/osd","thing/product/DOCK1/services","thing/product/DOCK1/drc/down","thing/product/DOCK1/services_reply"])assert.throws(()=>djiDiagnosticEvent(topic,raw({temperature:20}),"DOCK1"));
  for(const data of [{temperature:NaN},{humidity:101},{temperature:"35"},{latitude:1}])assert.throws(()=>djiDiagnosticEvent("thing/product/DOCK1/osd",raw(data),"DOCK1"));
  assert.throws(()=>djiDiagnosticEvent("thing/product/DOCK1/osd",Buffer.alloc(65537),"DOCK1"));
});
test("MQTT archive dispatcher uses fixed topic, QoS1 and non-retained data; no CID credentials",async()=>{
  let called=false;const adapter=mqttArchiveDispatcher({publish:async(topic,bytes,options)=>{called=true;assert.equal(topic,"archives/selected");assert.equal(options.qos,1);assert.equal(options.retain,false);assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()),{idempotencyKey:"key",event:{id:"a",kind:"archive",payload:null}});}},"archives/selected");
  await adapter.send({id:"a",kind:"archive",payload:null},"key",new AbortController().signal);assert.equal(called,true);
  for(const topic of ["device/+/services","thing/product/DEVICE/services","thing/product/DEVICE/drc/down"])assert.throws(()=>mqttArchiveDispatcher({publish:async()=>{}},topic));
});
test("HTTP dispatch never follows redirects or forwards incoming credentials",async()=>{
  const adapter=httpArchiveDispatcher("https://archive.example/events",async(_url,init)=>{assert.equal(init!.redirect,"error");assert.equal(new Headers(init!.headers).has("authorization"),false);assert.equal(new Headers(init!.headers).get("idempotency-key"),"key");return new Response("denied",{status:503});});
  await assert.rejects(adapter.send({id:"a",kind:"archive",payload:null},"key",new AbortController().signal),/denied/);
  assert.throws(()=>httpArchiveDispatcher("http://archive.example"));assert.throws(()=>httpArchiveDispatcher("https://user:password@example.com"));
});
test("backend metrics have fixed cardinality and sink failure cannot invalidate a committed event",async()=>{
  const s=await setup();const seen:unknown[]=[];const metrics=new IngestMetrics({count:(name,value)=>{seen.push([name,value]);throw new Error("observer failed");},record:(name,value)=>{seen.push([name,value]);}});
  const ingest=new ArchiveIngest(s.auth,{metrics});assert.equal(ingest.submit(s.owner.token,"spectre","gateway",s.owner.repo,{id:"selected",kind:"archive",payload:null}).stored,true);
  metrics.duration(12);assert.equal(metrics.snapshot().stored,1);assert.ok(!JSON.stringify(seen).includes(s.owner.token));assert.ok(!JSON.stringify(seen).includes("selected"));
});
test("token bucket refill is bounded and clock rollback never creates extra capacity",()=>{
  let now=0;const bucket=new TokenBucket(2,2,()=>now);assert.equal(bucket.take(),true);assert.equal(bucket.take(),true);assert.equal(bucket.take(),false);
  now=500;assert.equal(bucket.take(),true);now=100;assert.equal(bucket.take(),false);now=1000;assert.equal(bucket.take(),true);assert.equal(bucket.take(),false);
  assert.throws(()=>new TokenBucket(Infinity,2));assert.throws(()=>new TokenBucket(1,0));
});

test("catalog manifests preserve explicit data license and attribution without imagery/location ingestion",async()=>{
  const {catalogManifestEvent}=await import("./catalog.ts");
  const input={provider:"example-provider",dataset:"selected-local-asset",assetSha256:"a".repeat(64),license:"CC-BY-4.0",attribution:"Example Provider; selected metadata only"};
  const event=catalogManifestEvent("manifest",input);assert.equal((event.payload as Record<string,unknown>).license,"CC-BY-4.0");
  for(const patch of [{license:"UNKNOWN"},{attribution:""},{assetSha256:"not-a-checksum"},{latitude:1},{url:"https://user:secret@example.com"}])assert.throws(()=>catalogManifestEvent("manifest",{...input,...patch}));
});
