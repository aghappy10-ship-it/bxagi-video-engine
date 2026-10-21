# BXAGI standard advertising platform 2.2

## Goal
Multitenant cloud platform: upload assets → infer business scene → automatically assign a production employee → produce/optimize creatives → manage creatives and budgets → automatically assign a buying employee → launch on configured channel → import/fetch verified performance → create optimization tasks and bounded budget decisions. Drama is one profile, not the platform model. Registry allows custom profiles and falls back to general advertising; unsupported types never get fabricated capabilities.

## Architecture
Cloud API: `server/platform-api.mjs` and `server/platform-repository.mjs`; schema/migrations in `db/` and `drizzle/`. Framework route: `app/api/v2/[...path]/route.ts`. D1 `DB` stores tenant-scoped records; R2 `BUCKET` stores real files.
Shared employee/production engines: `shared/`; platform UI: `components/platform/`. Ads services/adapters: `server/ads-service.mjs`, `server/adapters/`. Compute jobs: `server/worker-api.mjs`, `worker/run.py`.

## Cloud authentication
Use only the server-verified BXAGI subject and its unique bxagiAccounts.userId mapping as tenant scope. Ignore other hosting identity headers, body/query user IDs and email equality. All project/file/creative/campaign/metric/connection/audit routes require the opaque BXAGI session before owned queries. Anonymous and invalid sessions receive 401; cross-owner records receive 404. Login/status/logout and bounded non-secret health are separate; worker routes still require their independent service secret. No credentials in browser storage. bxagiLegacyBindings preserves existing verified associations without merging ambiguous legacy owners.

## API base / records
`/api/v2`
- POST `/bxagi/auth/login` => actual official username/phone login and verified profile; GET `/bxagi/auth/status`, POST `/bxagi/auth/logout` manage the encrypted local connection. No upstream logout/refresh route is invented.
- POST `/bxagi/jobs/:id/sync` => owner-scoped staged employee task synchronization; remote writes with unknown outcome are not repeated automatically.
- GET `/bootstrap` => `{user:{id,displayName},projects:[],assets:[],creatives:[],campaigns:[],connections:[],employees:[],metrics:[],capabilities:{storage:true,modelConfigured:false,channels:[...]}}`.
- GET/POST `/projects`; POST body `{title,productName,description,facts:[],objective:'purchase'|'install'|'lead'|'views',audience,landingUrl}` => project. New project scene auto / productionEmployeeId general until meaningful evidence. Never require user to choose scene/employee.
- POST `/projects/:id/assets` raw upload, `X-Filename` URI encoded, `Content-Type` verified; optional `X-Asset-Role` ('source'|'reference'|'transcript'|'copy') => `{asset,project,assignment,job}`. Images/video/audio/text/SRT; storage limit 64MiB per upload, BXAGI transfer limited to16MiB per source, type validation, stream to R2, safe names. `job` indicates pending browser/media/model processing, not fake successful video.
- GET `/assets/:id/content` authorized R2 stream with correct MIME; other tenant gets404.
- POST `/projects/:id/plan` in required BXAGI mode => asynchronous `{provider:'bxagi',queued:true,project,job,assignment,variants:[]}` using an actual already-hired employee. Its completed output files, not local rule variants, become creatives. Legacy optional mode => `{project,assignment,variants:[{id,title,headline,body,cta,format,strategy,evidence:[],sourceAssetIds:[],status:'draft'}]}`; always auto productionEmployee, use shared rule plan or explicitly configured real model. Preserve source fact traces.
- POST `/projects/:id/creatives` raw actual PNG/WebM/MP4/SVG/text, headers X-Filename + `X-Creative-Metadata` URIencodedJSON `{variantId,title,format,employeeId,sourceAssetIds,validation:'browser-metadata'|'operator-reviewed',width,height,duration}` => `{creative}`. Store immutable content/ref; technical dimension check where possible; drafts not falsely semantically approved.
- POST `/creatives/:id/review` `{approved:true}` => reviewed creative with user/time/audit. Review is optional before launch; explicit launch approves the current selected creatives with an audit record. Automation runs after explicit launch.
- POST `/campaigns` => `{campaign}` with `{projectId,creativeIds:[],name,channel:'oceanengine'|'kuaishou'|'tencent'|'custom',dailyBudget,totalBudget,maxDailyBudget,targetRoi,objective,autoOptimize:false,connectionId,platformConfig:{...}}`. Automatically route an actual BXAGI employee via scene+objective+channel when connected; no automatic hire or renewal. Server budget max defaults1000 via env but user requested caps honored below configured maximum. No actual ad call on create.
- POST `/campaigns/:id/launch` => campaign; explicit user action approves current selected creatives, queues a real BXAGI buying task, then verifies its action/campaign/inputVersion decision before invoking the owner-bound budget-safe real adapter; unsupported/missing rights => blocked with actionable reasons, no pretend remoteId/spend. Transaction idempotent stages and audit, do not repeat uncertain external write automatically.
- POST `/campaigns/:id/pause`, POST `/campaigns/:id/sync` => verified platform reads/operations if available.
- POST `/campaigns/:id/budget` => inactive plans only, `{dailyBudget,totalBudget,maxDailyBudget,targetRoi}`; server caps, owner and atomic operation guard. Save does not resume; explicit resume checks actual lifetime spend and writes/readbacks current allowed channel budget.
- POST `/campaigns/:id/metrics` manual platform report `{date,spend,revenue,conversions,hasConversion,dataFresh,source}` => `{metric,decision,optimizationTask?}`; source marked 'manual' and metrics not fabricated. Unknown conversion=>ROI null; stale=>hold; evidence scarcity=>hold. No double sum daily snapshots; upsert campaign+date+source.
- GET/POST `/connections`; POST owner only `{channel,accountId,label,accessToken,expiresAt,appId?,appSecret?}` => masked info only. AES-GCM APP_ENCRYPTION_KEY runtime secret mandatory for key persistence; secrets never returned/bootstrap/export. Native dispatch auth distinct from ad account authorization. Do not put creds in browser localStorage. No configured encryption key =>503.
- GET `/audit` tenant scoped; GET `/projects/:id/export` => JSON delivery manifest (actual files via content endpoints).
- GET `/system/health` read-only version/integration/runtime flags, no secrets.
- POST `/worker/tick` service bearer APP_WORKER_SECRET (additional private hosting access only for historical private deployments); optional background runner. Monitors all due active campaigns for budget limits; ROI changes obey autoOptimize, no fake monitoring while no runner. UI `/campaigns/:id/sync` provides explicit sync path too.

## Feedback production
- POST `/projects/:id/plan` accepts optional `{optimizationTaskId}`. Owner/project/campaign/metric links are validated; one per-project production lease prevents concurrent overwrite.
- POST `/optimization-tasks/:id/complete` `{creativeIds}` requires actual stored new files linked to the current task revision. Completion means files were generated, not that efficacy improved.
- POST `/optimization-tasks/:id/retry` `{planRevision,reason}` releases only the current revision; old partial outputs cannot complete a new revision. Insufficient data stays awaiting_data; video content experiments stay needs_external_video_production.

## Legacy shared engine APIs
`employeeProfiles`: registry default apparel/drama/game/general production & buyer profiles, versioned definitions; `inferScene({title,description,facts,filenames,mimeTypes})` => `{scene,confidence,basis,engine:'rules',needsModel:boolean}`; unknown=>general, no image-content claim from filenames.
`selectProductionEmployee(scene,customProfiles=[])`; `selectBuyingEmployee({scene,objective,channel},customProfiles=[])` => profile. Both return deterministic versioned assignment automatically.
`buildCreativePlan({project,assets},options={})` => `{assignment,variants}`: truthful titles/headlines/body/CTA/stories based solely supplied facts; safe creative variants requested formats portrait/square/landscape; source evidence. General fallback works custom scene.
`renderImageCreative({sourceBlob,variant,onProgress})` => `{blob,mimeType:'image/png',width,height,validation:'browser-metadata'}` actual canvas. Format portrait1080x1920,square1080x1080,landscape1920x1080; fit preserving images; sourceFile required. No fabricated actual raster without bytes.
Legacy local video engine/FFmpeg retained separately; cloud cannot run FFmpeg. Existing video export can be imported by client for actual browser draft processing, not claim cloud GPU pipeline.

## Ads service interface
`connectionSummary(row)` excludes credentials.
`encryptConnectionSecrets(payload,key)`/`decryptConnectionSecrets` WebCrypto AES-GCM; runtime key base64/hex32bytes; no hardcoded keys.
`createAdsService({repository,bucket,env,fetcher})` => `{launch(userId,campaign),pause(userId,campaign),sync(userId,campaign),tick()}`. Repository adapter owned by cloud agent: methods load/get/updateCampaign, getConnection incl ciphertext, listCreatives, addAudit, upsertMetrics, addOptimizationTask, listDueCampaigns. Agree methods early rather than assumptions.
First adapter OceanEngine only where official API verified, others fail closed '尚未配置官方适配器'; interfaces extensible. Generic Webhook custom connection only if explicit server allowlist and authenticated endpoint, not arbitrary SSRF URL. No external provider calls during tests except local fake fixtures.

## Honest capabilities
Required deployment mode uses actual BXAGI hired employees, official identities and dedicated task conversations; legacy profile/Canvas/FFmpeg helpers remain separate. Employee metadata is routing evidence, not proof of runtime tool capabilities. Supported images/text/real video processing paths marked separately from pending ASR/TTS/semantic/ad-channel integrations. D1/R2 records are durable; user isolation actual. Never claim live model, real paid ads or background scheduling verified without corresponding credentials/runner tests.

## BXAGI production and background synchronization
`server/bxagi-auth.mjs`, `bxagi-session-repository.mjs`, `bxagi-workforce.mjs` and `bxagi-orchestrator.mjs` implement verified identity, fixed-origin observed protocol, dedicated conversation dispatch and actual bounded artifact import. Contract and live verification limits are in `BXAGI_INTEGRATION_CONTRACT.md` and `BXAGI_PROTOCOL.md`.

The service-authenticated `/worker/bxagi-tick` separately advances existing jobs and queues eligible feedback production only for campaigns with autoOptimize=true, same-owner/project real metrics and an unexpired BXAGI session. It does not hire employees, create new campaigns or authorize additional spend. The runner keeps BXAGI synchronization separate from the `/worker/tick` budget monitor. Each sync transfers at most one source or one result; partial results remain drafts until all manifest files validate. Startup READY or a sent message is not employee success. Actual continuous operation requires a deployed runner.
