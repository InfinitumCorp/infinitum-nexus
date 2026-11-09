import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@infinitum/lbrnth";
import { harness } from "./test-harness.ts";

test("CID host mounts drone archival routes with explicit revocable bearer, never ambient cookies", async () => {
  let paid = true;
  const h = await harness({labyrinth:{storage:new MemoryStorage(), entitled:() => paid}});
  try {
    const owner = await h.signUp("fleet-http");
    await h.suite.cid.createOrganization("Drone archive client", owner.cid);
    const lab = (body: unknown) => h.call("POST", "/api/labyrinth", body, owner.cookie, {"x-labyrinth":"1"});
    assert.equal((await lab({action:"consent", product:"daemon", scopes:["repo:read", "repo:write", "repo:admin"]})).status, 200);
    assert.equal((await lab({action:"provision", product:"daemon"})).status, 200);
    const repo = await lab({action:"create", product:"daemon", name:"fleet"});
    const delegated = await lab({action:"token", product:"daemon"});
    const headers = {authorization:`Bearer ${delegated.body.token}`};
    const register = {action:"register", repo:repo.body.id, expectedHead:null, vehicle:"civil-unit-1", systemId:1, componentId:1};
    assert.equal((await h.call("POST", "/api/drones/daemon", register, owner.cookie)).status, 401);
    const saved = await h.call("POST", "/api/drones/daemon", register, undefined, headers);
    assert.equal(saved.status, 200);
    const fleet = await h.call("POST", "/api/drones/daemon", {action:"fleet", repo:repo.body.id}, undefined, headers);
    assert.equal(fleet.body.vehicles[0].vehicle, "civil-unit-1");
    assert.equal(fleet.headers.get("cache-control"), "no-store");
    paid = false;
    assert.equal((await h.call("POST", "/api/drones/daemon", {action:"fleet", repo:repo.body.id}, undefined, headers)).status, 403);
    assert.equal((await h.call("POST", "/api/drones/daemon", {}, undefined, {...headers, origin:"https://attacker.example"})).status, 403);
  } finally {await h.close();}
});
test("drone routes fail closed without an operator-configured CID/Labyrinth service", async () => {
  const h = await harness();
  try {assert.equal((await h.call("POST", "/api/drones/pollen", {action:"fleet", repo:"missing"})).status, 503);}
  finally {await h.close();}
});
