import { test } from "node:test";
import assert from "node:assert/strict";
import { coverAction, config } from "./westbridge-covers.js";

const env = { WESTBRIDGE_COVER_ACTION_TOKEN: "x".repeat(64) };
test("requires independent secret and fixed HTTPS hostname", () => {
  assert.throws(() => config({}), /not configured/);
  assert.equal(config(env).base, "https://westbridgeinsight.com");
  assert.throws(() => config({...env, WESTBRIDGE_COVER_API_ORIGIN:"http://example.com"}), /canonical HTTPS/);
});
test("listing uses GET and does not send a request body", async () => {
  const fetcher = async (url, opts) => {
    assert.equal(url, "https://westbridgeinsight.com/api/difsync/covers/list");
    assert.equal(opts.method, "GET");
    assert.equal(opts.body, undefined);
    assert.equal(opts.redirect, "error");
    return {ok:true, json:async()=>({ok:true,pending:20,jobs:[]})};
  };
  assert.equal((await coverAction("list",undefined,{env,fetch:fetcher})).pending,20);
});
test("claim sends only job ID to fixed endpoint", async () => {
  const id="f00bdc3c-82db-4fe7-8c53-aa6d1715f6ba";
  const fetcher=async (url,opts)=>{
    assert.equal(url, "https://westbridgeinsight.com/api/difsync/covers/claim");
    assert.equal(opts.method,"POST");
    assert.deepEqual(JSON.parse(opts.body),{jobId:id});
    return {ok:true,json:async()=>({ok:true,job:{jobId:id}})};
  };
  assert.equal((await coverAction("claim",{jobId:id},{env,fetch:fetcher})).job.jobId,id);
});
test("remote HTTP failures omit untrusted response bodies",async()=>{
  const fetcher=async()=>({ok:false,status:403});
  await assert.rejects(coverAction("claim",{jobId:"a"},{env,fetch:fetcher}),/HTTP 403/);
});
test("safe specific Westbridge refusal is exposed without secrets",async()=>{
 const fetcher=async()=>({ok:false,status:422,json:async()=>({ok:false,error:"Oracle image failed byte/hash/dimension verification"})});
 await assert.rejects(
  coverAction("attach",{jobId:"a"},{env,fetch:fetcher}),
  /HTTP 422: Oracle image failed byte\/hash\/dimension verification/
 );
});
test("untrusted remote errors never leak URLs or credentials",async()=>{
 const fetcher=async()=>({ok:false,status:403,json:async()=>({error:"secrets: token=abc@test.example"})});
 await assert.rejects(
  coverAction("attach",{jobId:"a"},{env,fetch:fetcher}),
  e=> e.message==="Westbridge cover attach HTTP 403"
 );
});
test("unknown operation is rejected before networking",async()=>{
  await assert.rejects(coverAction("other",{}, {env}),/Unsupported/);
});
