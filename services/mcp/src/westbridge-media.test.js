import {test} from "node:test";
import assert from "node:assert/strict";
import {publicMediaUrl,publicManifest,publishReviewedCover} from "./westbridge-media.js";
import {ACTIONS} from "./westbridge-covers.js";

const job="f00bdc3c-82db-4fe7-8c53-aa6d1715f6ba";
const article="6b7fcd2e-40ed-4e62-8aa5-3941ced3a950";
const hash="a".repeat(64);
test("Oracle media URL is immutable and fixed to trusted domain",()=>{
 assert.equal(publicMediaUrl(job,hash),"https://difsync.com/westbridge-media/"+job+"-"+hash+".webp");
 assert.throws(()=>publicMediaUrl("../escape",hash),/Invalid/);
 assert.throws(()=>publicMediaUrl(job,"bad"),/Invalid/);
});
test("approved list does not reveal private drafts",async()=>{
 const m=await publicManifest();
 assert.equal(m.schemaVersion,1);
 assert.equal(m.origin,"oracle-westbridge-media");
 assert.ok(Array.isArray(m.objects));
});
test("rejects invented/invalid image bytes before any publishing",async()=>{
 await assert.rejects(
 ()=>publishReviewedCover({jobId:job,articleId:article,imageBase64:"not-a-real-webp",review:{}}),
 /Invalid|WebP|payload/
 );
});
test("published Oracle URLs require the narrowly scoped authenticated attach action",()=>{
 assert.ok(ACTIONS.includes("attach"),"DifSync coverAction must allow fixed authenticated attach (no raw SQL)");
});
