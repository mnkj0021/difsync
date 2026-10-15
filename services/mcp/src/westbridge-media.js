import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { coverAction } from "./westbridge-covers.js";

// Isolated on the Oracle host. No Westbridge production SQL credentials here.
// Only approved covers are publicly readable; original drafts stay private.
const ROOT = "/home/opc/services/westbridge-insight";
const APPROVED = path.join(ROOT, "covers", "approved");
const INBOX = path.join(ROOT, "covers", "inbox");
const REJECTED = path.join(ROOT, "covers", "rejected");
const URL_ROOT = "https://difsync.com/westbridge-media/";
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const SHA = /^[\da-f]{64}$/i;
const MAX_BYTES = 12 * 1024 * 1024;
// Valid, visually reviewed 1022x520 WebP photographs can compress below 90KB.
const MIN_BYTES = 16_384;
// Editorial failures only defer THEIR job, letting later FIFO jobs proceed.
// Archive every actual generation attempt: cooldown never restores attempts.
export const EDITORIAL_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const REVIEW_FLAGS = ["subjectMatch","noFabrication","goodComposition","noTextOrWatermark","notGeneric"];

function validateId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw Error("Invalid Westbridge identifier");
  return id.toLowerCase();
}
function decodeWebp(base64) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 16 * 1024 * 1024)
    throw Error("Image payload must be strict bounded base64");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES || buffer.toString("ascii",0,4)!=="RIFF" ||
      buffer.toString("ascii",8,12)!=="WEBP" || buffer.readUInt32LE(4)+8 !== buffer.length)
    throw Error("Invalid or oversized WebP image");
  const format=buffer.toString("ascii",12,16);
  let width=0,height=0;
  if(format==="VP8X" && buffer.length>30){
    width=1+buffer.readUIntLE(24,3);
    height=1+buffer.readUIntLE(27,3);
  } else if(format==="VP8 " && buffer.length>30 && buffer[23]===0x9d && buffer[24]===0x01 && buffer[25]===0x2a){
    width=buffer.readUInt16LE(26)&0x3fff;
    height=buffer.readUInt16LE(28)&0x3fff;
  } else if(format==="VP8L" && buffer.length>25 && buffer[20]===0x2f){
    width=1+(buffer[21]|((buffer[22]&0x3f)<<8));
    height=1+((buffer[22]>>6)|(buffer[23]<<2)|((buffer[24]&15)<<10));
  }
  if(width!==1022||height!==520)throw Error("Expected exactly 1022x520 WebP");
  return buffer;
}
export function validateReview(review,jobId,articleId,sha) {
  const auto=review?.reviewMode==="automatic-illustration";
  if(!review || typeof review!=="object" ||
    review.source!=="chatgpt-image-generator"||review.decision!=="approved"||
    review.jobId!==jobId || review.articleId!==articleId ||
    review.imageSha256?.toLowerCase()!==sha ||
    !Number.isInteger(review.attemptNumber)||review.attemptNumber<1||
    review.attemptNumber>(auto?1000:5)||
    typeof review.reason!=="string"||review.reason.trim().length<40||review.reason.length>600)
    throw Error("Invalid ChatGPT cover provenance or identity");
  if(auto){
    // AUTO mode is technical approval, never a fabricated editorial review.
    // False flags mean 'not verified', NOT 'known false'.
    if(review.confidence!==0||!REVIEW_FLAGS.every(k=>review[k]===false)||
       !review.reason.startsWith("Automatic illustrative cover:"))
      throw Error("Automatic illustration review must disclose unverified relevance");
  } else if(typeof review.confidence!=="number"||review.confidence<0.9||
       review.confidence>1||!REVIEW_FLAGS.every(k=>review[k]===true)) {
    throw Error("Editorial review failed");
  }
}
function nameFor(jobId,hash){return validateId(jobId)+"-"+hash+".webp"}
export function publicMediaUrl(jobId,sha){if(!SHA.test(sha))throw Error("Invalid SHA");return URL_ROOT+nameFor(jobId,sha)}
export async function publishReviewedCover(input, options={}){
  const jobId=validateId(input.jobId), articleId=validateId(input.articleId);
  const bytes=decodeWebp(input.imageBase64);
  const sha=crypto.createHash("sha256").update(bytes).digest("hex");
  validateReview(input.review,jobId,articleId,sha);
  let history={jobId,articleId,rejections:[]};
  try{history=JSON.parse(await fsp.readFile(path.join(REJECTED,jobId+".json"),"utf8"))}
  catch(e){if(e.code!=="ENOENT")throw e}
  if(history.jobId!==jobId || history.articleId!==articleId || !Array.isArray(history.rejections) ||
     (input.review.reviewMode!=="automatic-illustration" && history.rejections.length>=5) ||
     input.review.attemptNumber!==history.rejections.length+1)
    throw Error("Generation attempt count does not match the archived review history");
  const filename=nameFor(jobId,sha), imageUrl=publicMediaUrl(jobId,sha);
  await fsp.mkdir(APPROVED,{recursive:true,mode:0o700});
  await fsp.mkdir(INBOX,{recursive:true,mode:0o700});
  const tmp=path.join(INBOX,filename+"."+crypto.randomUUID()+".tmp");
  const final=path.join(APPROVED,filename);
  await fsp.writeFile(tmp,bytes,{flag:"wx",mode:0o600});
  let created = false;
  let attached = false;
  try {
    // Existing matching file is immutable: never overwrite it.
    await fsp.link(tmp,final).then(()=>{created=true}).catch(async e=>{
      if(e.code!=="EEXIST")throw e;
      const existing=await fsp.readFile(final);
      if(!crypto.timingSafeEqual(crypto.createHash("sha256").update(existing).digest(),crypto.createHash("sha256").update(bytes).digest()))
        throw Error("Existing approved image does not match SHA");
    });
    const attach=options.attach || (data=>coverAction("attach",data));
    const outcome=await attach({jobId,articleId,imageUrl,imageSha256:sha,review:input.review});
    if(!outcome||outcome.ok!==true||outcome.status!=="completed")throw Error("Westbridge refused cover attachment");
    attached = true;
    // The approved URL can be recovered if metadata persist fails.
    const record={jobId,articleId,imageUrl,imageSha256:sha,bytes:bytes.length,
      reviewMode:input.review.reviewMode||"editorially-reviewed",
      review:input.review,publishedAt:new Date().toISOString()};
    await fsp.writeFile(path.join(APPROVED,filename+".json"),JSON.stringify(record,null,2),{flag:"w",mode:0o600});
    return {ok:true,status:"completed",jobId,articleId,imageUrl,imageSha256:sha,bytes:bytes.length};
  } finally {
    await fsp.unlink(tmp).catch(()=>{});
    if (created && !attached) await fsp.unlink(final).catch(()=>{});
  }
}
/**
 * Deterministic audit record assembly, independent of disk I/O.
 * An actual generated candidate counts once; retries of the same generationId
 * must not silently use another of the five allowed attempts.
 */
export function appendCoverRejection(history,input,now=new Date().toISOString()) {
  const jobId=validateId(input.jobId),articleId=validateId(input.articleId);
  if(typeof input.reason!=="string"||input.reason.trim().length<25||input.reason.length>600)
    throw Error("Concrete editorial failure reason required");
  if(!history||history.jobId!==jobId||history.articleId!==articleId||
     !Array.isArray(history.rejections)||history.rejections.length>=5)
    throw Error("Review history conflict or five attempts exhausted");
  const generationId=typeof input.generationId==="string"?input.generationId.trim().slice(0,128):"";
  if(generationId && history.rejections.some(entry=>entry.generationId===generationId))
    throw Error("Generation already rejected; refusing duplicate attempt");
  const next=history.rejections.length+1;
  const atMs=Date.parse(now);
  if(!Number.isFinite(atMs))throw Error("Invalid editorial rejection timestamp");
  const deferredUntil=next<5?new Date(atMs+EDITORIAL_COOLDOWN_MS).toISOString():null;
  return {
    jobId, articleId,
    rejections:[...history.rejections,{
      attemptNumber:next,reason:input.reason.trim(),generationId,at:now,
      ...(deferredUntil?{deferredUntil}:{})
    }]
  };
}
export async function recordRejectedCover(input) {
  const jobId=validateId(input.jobId),articleId=validateId(input.articleId);
  if(typeof input.reason!=="string"||input.reason.trim().length<25||input.reason.length>600)
    throw Error("Concrete editorial failure reason required");
  await fsp.mkdir(REJECTED,{recursive:true,mode:0o700});
  const dest=path.join(REJECTED,jobId+".json");
  // Exclusive lock prevents two simultaneous workers from overwriting each
  // other's rejection records or consuming attempts for the same candidate.
  // Fail closed on an orphaned lock; operator must review before recovery.
  const lock=dest+".lock";
  let handle;
  try {
    handle=await fsp.open(lock,"wx",0o600);
  } catch (error) {
    if(error?.code==="EEXIST")throw Error("Cover rejection already in progress; retry after audit");
    throw error;
  }
  try {
    let history={jobId,articleId,rejections:[]};
    try {history=JSON.parse(await fsp.readFile(dest,"utf8"))}
    catch(error){if(error?.code!=="ENOENT")throw error}
    const data=appendCoverRejection(history,input);
    const temp=dest+"."+crypto.randomUUID()+".tmp";
    try{
      await fsp.writeFile(temp,JSON.stringify(data,null,2),{flag:"wx",mode:0o600});
      await fsp.rename(temp,dest);
    }finally{await fsp.unlink(temp).catch(()=>{})}
    return {ok:true,jobId,articleId,rejectedGenerations:data.rejections.length,
      remainingAttempts:5-data.rejections.length,
      deferredUntil:data.rejections.at(-1)?.deferredUntil||null};
  } finally {
    await handle.close();
    await fsp.unlink(lock);
  }
}
/**
 * Enrich the existing read-only Westbridge queue with Oracle's authoritative
 * per-job generation rejection count. A scheduler must never infer it from
 * prior chat context or assume attempt #1 after its process restarts.
 */
export async function withCoverReviewCounts(queue, options = {}) {
  const readFile = options.readFile || fsp.readFile;
  // Default on: the owner explicitly chose automatic decorative covers.
  // Manual-review mode remains available by setting this environment to 0.
  const autoApprove=options.autoApprove ?? process.env.WESTBRIDGE_COVER_AUTO_APPROVAL!=="0";
  const nowMs=options.now===undefined?Date.now():new Date(options.now).getTime();
  if(!Number.isFinite(nowMs))throw Error("Invalid queue clock");
  if (!queue || queue.ok !== true || !Array.isArray(queue.jobs)) throw Error("Invalid Westbridge queue response");
  const jobs = await Promise.all(queue.jobs.map(async job => {
    const jobId = validateId(job.jobId);
    const articleId = validateId(job.articleId);
    let count = 0;
    let lastEditorialRejection = null;
    let deferredUntil = null;
    try {
      const record = JSON.parse(await readFile(path.join(REJECTED, jobId + ".json"), "utf8"));
      if (record.jobId !== jobId || record.articleId !== articleId || !Array.isArray(record.rejections) ||
          record.rejections.length > 5 ||
          record.rejections.some(entry => typeof entry.reason !== "string"))
        throw Error("Oracle review history invalid for " + jobId);
      count = record.rejections.length;
      if (count > 0) {
        const last = record.rejections[count - 1];
        lastEditorialRejection = {
          reason: last.reason.slice(0, 600),
          at: typeof last.at === "string" ? last.at : null,
          generationId: typeof last.generationId === "string" ? last.generationId : null
        };
        if(count<5){
          // New records have explicit deferUntil. Historical records retain
          // accurate timestamped attempts and receive the same bounded window.
          const saved=typeof last.deferredUntil==="string"?Date.parse(last.deferredUntil):NaN;
          const created=typeof last.at==="string"?Date.parse(last.at):NaN;
          const untilMs=Number.isFinite(saved)?saved:
            (Number.isFinite(created)?created+EDITORIAL_COOLDOWN_MS:NaN);
          if(Number.isFinite(untilMs)&&untilMs>nowMs)
            deferredUntil=new Date(untilMs).toISOString();
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ...job, rejectedGenerations: count,
      remainingAttempts: autoApprove ? null : 5-count,
      nextAttemptNumber: autoApprove ? count+1 : (count<5?count+1:null),
      deferredUntil: autoApprove ? null : deferredUntil,
      ...(autoApprove?{reviewMode:"automatic-illustration"}:{}),
      ...(count === 5 ? { lastEditorialRejection } : {}) };
  }));
  // A spent job must not block fresh work just because Westbridge still
  // reports its article as coverless. Keep the raw count for diagnostics.
  // Prefer genuinely fresh articles, then lower retry counts.
  const eligible = autoApprove ? jobs : jobs.filter(job => job.remainingAttempts > 0);
  const ready = eligible.filter(job => job.deferredUntil === null);
  const deferred = eligible.filter(job => job.deferredUntil !== null);
  const exhausted = jobs.length - eligible.length;
  const archivedExhaustedListed=jobs.filter(job=>job.rejectedGenerations===5).length;
  // Auditable recovery index only: do NOT reopen or zero the five-attempt
  // counter. Each job requires an explicit human editorial decision before
  // any separate recovery implementation could consider more generation.
  const exhaustedReview = jobs.filter(job => job.rejectedGenerations === 5).map(job => ({
    jobId: job.jobId,
    articleId: job.articleId,
    title: job.title,
    slug: job.slug,
    rejectedGenerations: job.rejectedGenerations,
    lastEditorialRejection: job.lastEditorialRejection,
    recoveryState: autoApprove ? "historic-exhaustion-superseded-by-owner-auto-mode" :
      "manual-editorial-review-required",
    automaticGenerationAllowed: autoApprove
  }));
  // Preserve original FIFO among READY articles. A failed job does not
  // permanently block all later jobs while it cools down.
  const deferredReview=deferred.map(job=>({
    jobId:job.jobId,articleId:job.articleId,title:job.title,
    rejectedGenerations:job.rejectedGenerations,
    remainingAttempts:job.remainingAttempts,
    nextAttemptNumber:job.nextAttemptNumber,
    deferredUntil:job.deferredUntil,
    recoveryState:"editorial-cooldown"
  }));
  const nextReadyAt=deferred.length?
    deferred.map(job=>job.deferredUntil).sort()[0]:null;
  const rawPending = typeof queue.pending === "number" ? queue.pending : jobs.length;
  return {
    ...queue,
    rawPending,
    pending: queue.truncated ? Math.max(eligible.length, rawPending - exhausted) : eligible.length,
    eligibleListed: eligible.length,
    readyListed: ready.length,
    deferredListed: deferred.length,
    nextReadyAt,
    deferredReview,
    exhaustedListed: exhausted,
    archivedExhaustedListed,
    exhaustedReview,
    reviewPolicy: autoApprove ? "automatic-illustration-no-editorial-rejections" : "manual-editorial-review",
    // The worker must see ONE ready article at a time; never re-sort jobs.
    // It can continue past a rejected article without bypassing exhaustion.
    nextJob: ready[0] || null,
    listedCount: Math.min(1, ready.length),
    selectionPolicy: "fifo-oldest-eligible",
    deferPolicy: autoApprove ? "disabled-automatic-illustrations" :
      "per-article-12h-after-editorial-rejection",
    jobs: ready.slice(0, 1)
  };
}

export async function publicManifest(){
  let names=[];
  try{names=await fsp.readdir(APPROVED)}catch(e){if(e.code!=="ENOENT")throw e}
  const objects=[];
  for(const n of names.filter(x=>/^[a-f0-9-]{36}-[a-f0-9]{64}\.webp\.json$/.test(x)).slice(0,1000)){
    try{
      const m=JSON.parse(await fsp.readFile(path.join(APPROVED,n),"utf8"));
      if(m.imageUrl===URL_ROOT+n.slice(0,-5) && UUID.test(m.jobId) && UUID.test(m.articleId)&&SHA.test(m.imageSha256)){
        objects.push({jobId:m.jobId,articleId:m.articleId,url:m.imageUrl,
          filename:n.slice(0,-5),sizeBytes:m.bytes,publishedAt:m.publishedAt,
          reviewMode:m.reviewMode||"editorially-reviewed"});
      }
    }catch{}
  }
  return {schemaVersion:1,origin:"oracle-westbridge-media",updatedAt:new Date().toISOString(),objects};
}
export async function servePublicMedia(req,res,pathname){
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405);res.end();return}
  if(pathname==="/westbridge-media/manifest.json"){
    const data=JSON.stringify(await publicManifest());
    res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"public,max-age=60","x-content-type-options":"nosniff"});
    if(req.method==="HEAD")res.end(); else res.end(data);
    return;
  }
  const file=pathname.slice("/westbridge-media/".length);
  if(!/^[a-f0-9-]{36}-[a-f0-9]{64}\.webp$/.test(file)){res.writeHead(404);res.end();return}
  const abs=path.join(APPROVED,file);
  let stat;
  try{stat=await fsp.lstat(abs);if(!stat.isFile()||stat.isSymbolicLink())throw Error("not regular")}catch{res.writeHead(404);res.end();return}
  res.writeHead(200,{"content-type":"image/webp","content-length":stat.size,"cache-control":"public,max-age=31536000,immutable","x-content-type-options":"nosniff"});
  if(req.method==="HEAD"){res.end();return}
  fs.createReadStream(abs).on("error",()=>res.destroy()).pipe(res);
}
