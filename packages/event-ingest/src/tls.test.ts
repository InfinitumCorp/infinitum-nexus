import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { ArchiveIngest } from "./service.ts";
import { createArchiveServer,createArchiveClient } from "./tls.ts";
import { setup } from "./testing.ts";

async function harness() {
  const dir=mkdtempSync(join(tmpdir(),"ingest-tls-"));
  const openssl=(...args:string[])=>execFileSync("openssl",args,{cwd:dir,stdio:"ignore"});
  openssl("req","-x509","-newkey","rsa:2048","-nodes","-keyout","ca.key","-out","ca.crt","-days","1","-subj","/CN=Archive Test CA");
  for(const name of ["server","client","stranger"]) {
    openssl("req","-newkey","rsa:2048","-nodes","-keyout",name+".key","-out",name+".csr","-subj","/CN="+name);
    const {writeFileSync}=await import("node:fs");
    writeFileSync(join(dir,name+".ext"),name==="server"?"subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n":"extendedKeyUsage=clientAuth\n");
    openssl("x509","-req","-in",name+".csr","-CA","ca.crt","-CAkey","ca.key","-CAcreateserial","-out",name+".crt","-days","1","-extfile",name+".ext");
  }
  const read=(name:string)=>readFileSync(join(dir,name));
  const s=await setup(), ingest=new ArchiveIngest(s.auth,{dispatcher:{send:async()=>{}}});
  const server=createArchiveServer(ingest,{key:read("server.key"),cert:read("server.crt"),ca:read("ca.crt"),peers:[{fingerprint256:new X509Certificate(read("client.crt")).fingerprint256,source:"trusted-upload",repositories:{daemon:s.owner.repo,slug:s.owner.repo,orbis:s.owner.repo,pollen:s.owner.repo,flower:s.owner.repo,cloud:s.owner.repo,hrvst:s.owner.repo,metatron:s.owner.repo,fabric:s.owner.repo,aether:s.owner.repo}}]});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const origin=`https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tls={ca:read("ca.crt"),cert:read("client.crt"),key:read("client.key")};
  const raw=(body:unknown,certificate=true,extra:Record<string,string>={},stranger=false)=>new Promise<{status:number,body:Record<string,unknown>}>( (resolve,reject)=>{
    const cert=stranger?read("stranger.crt"):tls.cert,key=stranger?read("stranger.key"):tls.key;
    const req=request(origin+"/api/archive-ingest/daemon",{method:"POST",agent:false,ca:tls.ca,...(certificate?{cert,key}:{}),headers:{"content-type":"application/json",authorization:`Bearer ${s.owner.token}`,...extra}},res=>{
      const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on("error",reject);req.end(JSON.stringify(body));
  });
  return {s,ingest,server,origin,tls,raw,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}};
}
test("real TLS handshake plus CID bearer produce bounded stored/delivered receipts",async()=>{
  const h=await harness();try {
    const client=createArchiveClient({origin:h.origin,product:"daemon",...h.tls,token:()=>h.s.owner.token});
    const first=await client.submit({id:"test-1",kind:"archive",payload:{selected:true}});
    assert.equal(first.stored,true);assert.equal(first.delivery,"pending");
    assert.equal((await client.submit({id:"test-1",kind:"archive",payload:{selected:true}})).duplicate,true);
    assert.equal((await client.deliver("test-1")).delivery,"delivered");
    assert.equal((await client.receipt("test-1")).delivery,"delivered");
    h.s.setPaid(false);await assert.rejects(client.receipt("test-1"),/403/);
  }finally{await h.close();}
});
test("no client certificate fails TLS; CA-valid but unregistered fingerprint is denied",async()=>{
  const h=await harness();try {
    await assert.rejects(h.raw({action:"receipt",id:"missing"},false,{"x-client-verified":"true"}));
    assert.equal((await h.raw({action:"receipt",id:"missing"},true,{},true)).status,403);
  }finally{await h.close();}
});
test("mTLS does not grant CID identity, source selection, arbitrary repo or cross-origin browser access",async()=>{
  const h=await harness();try {
    assert.equal((await h.raw({action:"submit",event:{id:"e",kind:"archive",payload:null}},true,{authorization:"Bearer forged"})).status,403);
    assert.equal((await h.raw({action:"receipt",id:"e",source:"spoof",repo:"spoof"})).status,400);
    assert.equal((await h.raw({action:"receipt",id:"e"},true,{origin:h.origin})).status,403);
    const client=createArchiveClient({origin:h.origin,product:"eon",...h.tls,token:()=>h.s.owner.token});
    await assert.rejects(client.submit({id:"no",kind:"archive",payload:null}),/403/);
  }finally{await h.close();}
});
test("gateway refuses oversized bodies, operational actions and compressed content",async()=>{
  const h=await harness();try {
    assert.equal((await h.raw({blob:"x".repeat(70000)})).status,413);
    assert.equal((await h.raw({action:"command",id:"e"})).status,400);
    assert.equal((await h.raw({action:"receipt",id:"e"},true,{"content-encoding":"gzip"})).status,415);
  }finally{await h.close();}
});

test("five existing product archive clients write isolated namespaces over real mTLS",async()=>{
  const h=await harness();try {
    for(const [module,name,product] of [["cloud","createCloudArchiveClient","cloud"],["hrvst","createHrvstArchiveClient","hrvst"],["metatron","createMetatronArchiveClient","metatron"],["fabric","createFabricArchiveClient","fabric"],["aether","createAetherArchiveClient","aether"]]) {
      const exports=await import(`../../${module}/src/ingest.ts`);
      const client=exports[name!]({origin:h.origin,...h.tls,token:()=>h.s.owner.token});
      assert.equal((await client.submit({id:"shared-id",kind:"archive",payload:{selected:true}})).stored,true);
      assert.ok(h.s.auth.forProduct(h.s.owner.token,product!).history(h.s.owner.repo)[0]!.tree[`products/${product}/ingest/trusted-upload/shared-id.json`]);
    }
  }finally{await h.close();}
});
test("five drone archive clients retain independent namespaces over real TLS",async()=>{
  const h=await harness();try {
    const {createDroneArchiveClient}=await import("../../drone-backend/src/ingest.ts");
    for(const product of ["daemon","slug","orbis","pollen","flower"] as const) {
      const client=createDroneArchiveClient(product,{origin:h.origin,...h.tls,token:()=>h.s.owner.token});
      assert.equal((await client.submit({id:"fleet-archive",kind:"archive",payload:{selected:true}})).stored,true);
      assert.ok(h.s.auth.forProduct(h.s.owner.token,product).history(h.s.owner.repo)[0]!.tree[`products/${product}/ingest/trusted-upload/fleet-archive.json`]);
    }
  }finally{await h.close();}
});
