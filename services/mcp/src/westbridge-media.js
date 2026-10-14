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
function validateReview(review,jobId,articleId,sha) {
  if(!review || typeof review!=="object" ||
    review.source!=="chatgpt-image-generator"||review.decision!=="approved"||
    review.jobId!==jobId || review.articleId!==articleId ||
    review.imageSha256?.toLowerCase()!==sha ||
    !Number.isInteger(review.attemptNumber)||review.attemptNumber<1||review.attemptNumber>5 ||
    typeof review.confidence!=="number"||review.confidence<0.9||review.confidence>1 ||
    typeof review.reason!=="string"||review.reason.trim().length<40||review.reason.length>600||
    !REVIEW_FLAGS.every(k=>review[k]===true)) throw Error("Editorial review failed");
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
     history.rejections.length>=5 || input.review.attemptNumber!==history.rejections.length+1)
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
    const record={jobId,articleId,imageUrl,imageSha256:sha,bytes:bytes.length,review:input.review,publishedAt:new Date().toISOString()};
    await fsp.writeFile(path.join(APPROVED,filename+".json"),JSON.stringify(record,null,2),{flag:"w",mode:0o600});
    return {ok:true,status:"completed",jobId,articleId,imageUrl,imageSha256:sha,bytes:bytes.length};
  } finally {
    await fsp.unlink(tmp).catch(()=>{});
    if (created && !attached) await fsp.unlink(final).catch(()=>{});
  }
}
export async function recordRejectedCover(input) {
  const jobId=validateId(input.jobId),articleId=validateId(input.articleId);
  if(typeof input.reason!=="string"||input.reason.trim().length<25||input.reason.length>600)throw Error("Concrete reason required");
  await fsp.mkdir(REJECTED,{recursive:true,mode:0o700});
  const dest=path.join(REJECTED,jobId+".json");
  let data={jobId,articleId,rejections:[]};
  try{data=JSON.parse(await fsp.readFile(dest,"utf8"))}catch(e){if(e.code!=="ENOENT")throw e}
  if(data.jobId!==jobId||data.articleId!==articleId||!Array.isArray(data.rejections)||data.rejections.length>=5)throw Error("Review history conflict or five attempts exhausted");
  data.rejections.push({attemptNumber:data.rejections.length+1,reason:input.reason,generationId:String(input.generationId||"").slice(0,128),at:new Date().toISOString()});
  const temp=dest+"."+crypto.randomUUID()+".tmp";
  await fsp.writeFile(temp,JSON.stringify(data,null,2),{flag:"wx",mode:0o600});
  await fsp.rename(temp,dest);
  return {ok:true,jobId,articleId,rejectedGenerations:data.rejections.length,remainingAttempts:5-data.rejections.length};
}
/**
 * Enrich the existing read-only Westbridge queue with Oracle's authoritative
 * per-job generation rejection count. A scheduler must never infer it from
 * prior chat context or assume attempt #1 after its process restarts.
 */
export async function withCoverReviewCounts(queue, options = {}) {
  const readFile = options.readFile || fsp.readFile;
  if (!queue || queue.ok !== true || !Array.isArray(queue.jobs)) throw Error("Invalid Westbridge queue response");
  const jobs = await Promise.all(queue.jobs.map(async job => {
    const jobId = validateId(job.jobId);
    const articleId = validateId(job.articleId);
    let count = 0;
    try {
      const record = JSON.parse(await readFile(path.join(REJECTED, jobId + ".json"), "utf8"));
      if (record.jobId !== jobId || record.articleId !== articleId || !Array.isArray(record.rejections) ||
          record.rejections.length > 5) throw Error("Oracle review history invalid for " + jobId);
      count = record.rejections.length;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ...job, rejectedGenerations: count, remainingAttempts: 5 - count,
      nextAttemptNumber: count < 5 ? count + 1 : null };
  }));
  // A spent job must not block fresh work just because Westbridge still
  // reports its article as coverless. Keep the raw count for diagnostics.
  // Prefer genuinely fresh articles, then lower retry counts.
  const eligible = jobs.filter(job => job.remainingAttempts > 0);
  const exhausted = jobs.length - eligible.length;
  // Keep Westbridge's authoritative createdAt ASC / jobId ASC FIFO order.
  // Never re-sort on generation failures, title, image category, or retry count.
  const rawPending = typeof queue.pending === "number" ? queue.pending : jobs.length;
  return {
    ...queue,
    rawPending,
    pending: queue.truncated ? Math.max(eligible.length, rawPending - exhausted) : eligible.length,
    eligibleListed: eligible.length,
    exhaustedListed: exhausted,
    // The worker must see only ONE article at a time. Next call after
    // completion/final rejection moves to the next oldest eligible item.
    nextJob: eligible[0] || null,
    listedCount: Math.min(1, eligible.length),
    selectionPolicy: "fifo-oldest-eligible",
    jobs: eligible.slice(0, 1)
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
        objects.push({jobId:m.jobId,articleId:m.articleId,url:m.imageUrl,filename:n.slice(0,-5),sizeBytes:m.bytes,publishedAt:m.publishedAt});
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
