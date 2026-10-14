# Oracle-first Westbridge cover workflow

## Purpose
Westbridge's production VPS remains the authoritative website and database host. Heavy, persistent ChatGPT cover workflow files and archives live separately on Oracle under /home/opc/services/westbridge-insight/.

Oracle folders: covers/inbox (transfers), covers/approved (immutable reviewed WebP + metadata), covers/rejected (genuine rejection history), queue (read-only snapshots), logs, docs.
Only original built-in ChatGPT image generations are permitted: never use Gemini, image API, external/PC GPUs, stock, SVG, generic gradients, or unsupported depictions.

## Revised flow (no early claim)
1. Westbridge publishes articles. Queue snapshots expose all published, coverless eligible articles.
2. Hourly ChatGPT scheduler reads snapshot, generates actual original editorial images for each pending article as capacity permits, up to five real attempts per article.
3. ChatGPT performs quality review; rejected attempts recorded in the Oracle isolated archive with concrete reasons.
4. ChatGPT normalizes accepted image to 1022x520 WebP, calculates SHA256 and submits to dedicated DifSync westbridge_cover_publish_oracle action.
5. DifSync stores the approved image under Oracle isolated path, publicly serves it as https://difsync.com/westbridge-media/<JOB-UUID>-<SHA256>.webp, and requests the narrowly scoped Westbridge /api/difsync/covers/attach action.
6. Westbridge fetches the exact fixed HTTPS URL, verifies WebP bytes, 1022x520 and SHA256, then atomically writes ONLY Article.coverImage plus the matching ImageRelayJob's completed metadata. No SQL credentials leave production.
7. Westbridge admin Files > Oracle covers shows immutable approved images, gallery view, public URL and article usages using the read-only /westbridge-media/manifest.json catalog.
8. Verify the image HTTP 200, proper publication and no changes to title, article content, citations, sources or status.

## Security and status
No anonymous direct database updates. DifSync OAuth plus a previously configured dedicated server-to-server credential authorizes exactly the attachment action without repeated browser prompts.
Do not attempt to bypass blocked platform permissions using shell wrappers or alternate command systems. Do not claim publication unless a real image was generated, reviewed, transferred and verified.
The Oracle static-media handler and nginx location must be deployed to production and tested separately. The Westbridge API/admin changes need a full tested production build; existing old production build cannot run them.
If a read-only queue includes an article with an image, refresh before final attachment and the DB conditional update must refuse overwriting existing covers.

## Operator checklist
- Commit tested source to both GitHub repositories.
- Build the updated Westbridge application off-line/in staging; preserve current production and uploads with rollback.
- Install nginx /westbridge-media/ fixed proxy to local Oracle MCP HTTP 8891, test nginx -t then reload.
- Start DifSync MCP HTTP with updated source and restart after validation.
- Deploy Westbridge route and file-manager changes; verify OAuth, server credential and middleware route exemptions.
- Smoke-test GET manifest.json and one approved ChatGPT image through attachment and Admin Files. Leave full batch inactive until passed.
- Only enable new scheduled worker prompt after all actions are visible and allowed. Respect run execution time and real image quota.

Admin's Oracle root shows completed covers only. Draft/rejected files remain private on Oracle.

## 2026-10-14: Wrong-topic generation rejection and resume guard

- An unattended cover run generated an unrelated city skyline while the current queued article concerned retail-sector cyberattacks. The image was **not published**. Its actual generated candidate was inspected and a factual rejection was recorded using `westbridge_cover_reject_oracle` for job `59eb7a2d-980b-4656-9118-ad0b4b52484e`, article `3adbb98a-6d76-4120-979c-a2173b1b639d`.
- The Oracle MCP `westbridge_cover_list` response is now enriched read-only with persistent `rejectedGenerations`, `remainingAttempts`, and `nextAttemptNumber` for each listed job. Counts come from per-job rejection archives on Oracle, not chat memory. Five archived rejections set `remainingAttempts=0` and `nextAttemptNumber=null`; the scheduler must skip exhausted jobs.
- Before every `image_gen` invocation, the scheduled worker must establish a **new article-specific brief** based only on the current job title and excerpt. It must visually inspect the generated subject against that brief, immediately persist mismatches via `westbridge_cover_reject_oracle`, and never reuse previous article images or infer the attempt number.
- This improves traceability, not a perfect semantic guarantee. The publishing API validates bytes, SHA, dimensions and declared review; it cannot independently establish article relevance from pixels without actual visual inspection. Do not claim unattended end-to-end accuracy until subsequent scheduled runs demonstrate relevant images and verified publication.
- Implementation: `services/mcp/src/westbridge-media.js` (`withCoverReviewCounts`), `services/mcp/src/http.js`, regression tests `services/mcp/src/westbridge-media.test.js`. Production commit `b613378`.
