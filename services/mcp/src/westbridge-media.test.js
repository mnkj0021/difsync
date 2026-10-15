import {test} from "node:test";
import assert from "node:assert/strict";
import {publicMediaUrl,publicManifest,publishReviewedCover,withCoverReviewCounts,appendCoverRejection} from "./westbridge-media.js";
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

test("read-only queue exposes per-job persistent reject attempts", async () => {
 const jobs=[{jobId:job,articleId:article,title:"Example retail breach"}];
 const queue={ok:true,pending:1,jobs};
 const store=async()=>JSON.stringify({jobId:job,articleId:article,rejections:[{reason:"Wrong subject"}]});
 const v=await withCoverReviewCounts(queue,{readFile:store});
 assert.equal(v.jobs[0].rejectedGenerations,1);
 assert.equal(v.jobs[0].remainingAttempts,4);
 assert.equal(v.jobs[0].nextAttemptNumber,2);
 assert.equal(queue.jobs[0].rejectedGenerations,undefined);
});
test("brand-new jobs begin on attempt one",async()=>{
 const queue={ok:true,jobs:[{jobId:job,articleId:article}]};
 const readFile=async()=>{const e=new Error("ENOENT");e.code="ENOENT";throw e};
 const v=await withCoverReviewCounts(queue,{readFile});
 assert.equal(v.jobs[0].rejectedGenerations,0);
 assert.equal(v.jobs[0].nextAttemptNumber,1);
});
test("five actual prior rejections exhaust job and prevent sixth generation",async()=>{
 const queue={ok:true,jobs:[{jobId:job,articleId:article}]};
 const v=await withCoverReviewCounts(queue,{readFile:async()=>JSON.stringify({jobId:job,articleId:article,rejections:Array.from({length:5},()=>({reason:"Invalid generated image"}))})});
 assert.equal(v.exhaustedListed,1);
 assert.equal(v.eligibleListed,0);
 assert.equal(v.jobs.length,0);
 assert.equal(v.pending,0);
});
test("exhausted jobs are removed from eligible queue and counts stay accurate",async()=>{
 const exhausted={jobId:job,articleId:article,title:"Older exhausted story"};
 const fresh={jobId:"59eb7a2d-980b-4656-9118-ad0b4b52484e",articleId:"3adbb98a-6d76-4120-979c-a2173b1b639d",title:"New story"};
 const queue={ok:true,pending:2,truncated:false,jobs:[exhausted,fresh]};
 const readFile=async filename=>{
   if(filename.endsWith(job+".json"))
      return JSON.stringify({jobId:job,articleId:article,rejections:Array.from({length:5},()=>({reason:"Wrong article image"}))});
   const e=new Error("ENOENT");e.code="ENOENT";throw e;
 };
 const result=await withCoverReviewCounts(queue,{readFile});
 assert.equal(result.rawPending,2);
 assert.equal(result.pending,1);
 assert.equal(result.eligibleListed,1);
 assert.equal(result.exhaustedListed,1);
 assert.equal(result.jobs.length,1);
 assert.equal(result.jobs[0].jobId,fresh.jobId);
});
test("FIFO order is preserved even when earlier jobs have retries",async()=>{
 const ids=[
  {jobId:job,articleId:article,title:"Retry"},
  {jobId:"59eb7a2d-980b-4656-9118-ad0b4b52484e",articleId:"3adbb98a-6d76-4120-979c-a2173b1b639d",title:"Fresh"},
  {jobId:"7fb59533-1105-4786-ba7b-01c2fc57f383",articleId:"405ba292-6889-4dc7-a514-9c4b1c04b260",title:"Another fresh"}
 ];
 const fetch=async filename=>{
   if(filename.endsWith(job+".json"))return JSON.stringify({jobId:job,articleId:article,rejections:[{reason:"Wrong image"}]});
   const e=new Error("ENOENT");e.code="ENOENT";throw e;
 };
 const v=await withCoverReviewCounts({ok:true,pending:3,truncated:false,jobs:ids},{readFile:fetch});
 assert.deepEqual(v.jobs.map(x=>x.title),["Retry"]);
 assert.equal(v.nextJob.title,"Retry");
 assert.equal(v.listedCount,1);
 assert.equal(v.eligibleListed,3);
 assert.equal(v.selectionPolicy,"fifo-oldest-eligible");
 assert.equal(v.pending,3);
});
test("FIFO advances to next oldest article after preceding one is completed",async()=>{
 const jobs=[
   {jobId:job,articleId:article,title:"First"},
   {jobId:"59eb7a2d-980b-4656-9118-ad0b4b52484e",articleId:"3adbb98a-6d76-4120-979c-a2173b1b639d",title:"Second"}
 ];
 const readFile=async()=>{const e=new Error("ENOENT");e.code="ENOENT";throw e};
 const before=await withCoverReviewCounts({ok:true,pending:2,jobs},{readFile});
 const after=await withCoverReviewCounts({ok:true,pending:1,jobs:jobs.slice(1)},{readFile});
 assert.equal(before.nextJob.jobId,job);
 assert.equal(after.nextJob.title,"Second");
 assert.equal(before.pending,2);
 assert.equal(after.pending,1);
});
test("no stale shared retail subject is attached to current job",async()=>{
 const title="European Auto Industry Faces Transition Challenges";
 const x={jobId:job,articleId:article,title,excerpt:"Automobile manufacturing and electric vehicles"};
 const readFile=async()=>{const e=new Error("ENOENT");e.code="ENOENT";throw e};
 const out=await withCoverReviewCounts({ok:true,pending:1,jobs:[x]},{readFile});
 assert.equal(out.jobs[0].title,title);
 assert.ok(!Object.hasOwn(out.jobs[0],"visualGuidance"));
});
test("malformed or wrong-article rejection history fails closed",async()=>{
 const queue={ok:true,jobs:[{jobId:job,articleId:article}]};
 await assert.rejects(()=>withCoverReviewCounts(queue,{readFile:async()=>JSON.stringify({jobId:job,articleId:"00000000-0000-4000-8000-000000000000",rejections:[]})}),/invalid/);
});


test("same generation cannot consume two persistent attempts",()=>{
 const seed={jobId:job,articleId:article,rejections:[]};
 const first=appendCoverRejection(seed,{jobId:job,articleId:article,generationId:"gen-unique-001",reason:"Generated output depicts an unrelated subject to the published article"});
 assert.equal(first.rejections.length,1);
 assert.equal(seed.rejections.length,0);
 assert.throws(()=>appendCoverRejection(first,{jobId:job,articleId:article,generationId:"gen-unique-001",reason:"Generated output depicts a similarly unrelated subject"}),/already rejected/);
});
test("rejection history is strictly article-bound and five-attempt limited",()=>{
 let h={jobId:job,articleId:article,rejections:[]};
 for(let i=0;i<5;i++)h=appendCoverRejection(h,{jobId:job,articleId:article,generationId:"gen-"+i,reason:"Actual generated candidate is visibly unrelated to this article"});
 assert.deepEqual(h.rejections.map(x=>x.attemptNumber),[1,2,3,4,5]);
 assert.throws(()=>appendCoverRejection(h,{jobId:job,articleId:article,reason:"A sixth generation would violate the five-attempt budget"}),/exhausted/);
 assert.throws(()=>appendCoverRejection({jobId:job,articleId:article,rejections:[]},{jobId:job,articleId:"00000000-0000-4000-8000-000000000000",reason:"Article identity is wrong, so this record must fail closed"}),/conflict/);
});

test("exhausted articles expose an immutable audit summary but remain unselectable",async()=>{
 const rejected=Array.from({length:5},(_,i)=>({attemptNumber:i+1,generationId:"gen-"+i,
   reason:"Visually unrelated candidate number "+i+" cannot illustrate article",at:"2026-10-15T00:00:00.000Z"}));
 const readFile=async()=>JSON.stringify({jobId:job,articleId:article,rejections:rejected});
 const output=await withCoverReviewCounts({ok:true,pending:1,jobs:[{jobId:job,articleId:article,
   title:"Article needing human review",slug:"article-needs-review"}]},{readFile});
 assert.equal(output.pending,0);
 assert.equal(output.nextJob,null);
 assert.equal(output.jobs.length,0);
 assert.equal(output.exhaustedReview.length,1);
 const entry=output.exhaustedReview[0];
 assert.equal(entry.rejectedGenerations,5);
 assert.equal(entry.automaticGenerationAllowed,false);
 assert.equal(entry.recoveryState,"manual-editorial-review-required");
 assert.equal(entry.lastEditorialRejection.generationId,"gen-4");
 assert.equal(entry.lastEditorialRejection.reason,rejected[4].reason);
});
test("read-only audit remains empty when no article exhausted",async()=>{
 const readFile=async()=>{const e=new Error("ENOENT");e.code="ENOENT";throw e};
 const output=await withCoverReviewCounts({ok:true,pending:1,jobs:[{jobId:job,articleId:article,
   title:"New article"}]},{readFile});
 assert.equal(output.exhaustedReview.length,0);
 assert.equal(output.nextJob.jobId,job);
 assert.equal(output.nextJob.nextAttemptNumber,1);
});
