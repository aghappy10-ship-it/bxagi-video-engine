# BXAGI MVP interface contract

## Deliverable
Static Chinese product workspace in `dist/`, deployable local production service in `backend/`, runnable with Python 3.10+ and ffmpeg/ffprobe. No external service required for deterministic clipping from imported SRT. No invented production benchmarks or simulated ad execution.

## Module boundaries
The frontend uses native ES modules: `app.js` bootstraps the controller; `dist/app/` provides workspace, API, import, metrics, routing and shared UI modules; `dist/pages/` contains seven page renderers. `domain.mjs` and `video-engine.mjs` remain the business and browser-media interfaces below.

The backend keeps `server.py` as a compatible entrypoint and delegates HTTP, application services, SQLite, FFmpeg and pure rules to `backend/bxagi/`. See `ARCHITECTURE.md` for maintenance paths.

Workspace storage key and schema remain `bxagi.workspace.v1` / version 1. Nonsecret planning preferences use `bxagi.planning.v1`; API credentials remain in session storage and never enter workspace exports.

## domain.mjs exports
`parseSrt(srt)` => array `{id,start,end,text}`; throws meaningful Chinese error.
`planClips(segments,{count=3,minDuration=5,maxDuration=45,strategy='hook',duration=Infinity})` => array `{id,title,start,end,text,strategy,score}`. Picks complete non-overlapping windows; fewer than requested if insufficient segments.
`validateClip(clip,segments,duration)` => `{passed:false,sentencePassed,checks:[{name,status:'pass'|'fail'|'unverified',detail}],errors:[]}`; plan checks cannot establish media output validity. No subtitle data means sentence gate unverified, never passed. Production server is authoritative for final technical gates.
`evaluateCampaign(campaign)` => `{action:'hold'|'pause'|'increase'|'approval',reason,newBudget,roi}`. Input `{dailyBudget,spend,revenue,conversions,targetRoi,maxDailyBudget=1000,minSpend=100,dataFresh=true,hasConversion=true}`. Unknown conversions means ROI null; stale data means hold. Only local advice, never claim ad execution.
`productLines` => list of 3 products with name,id,subtitle,features,available,pending,delivery,metering.
`fmtTime(seconds)` => mm:ss.
`csv(rows)` => escaped CSV with header.

## video-engine.mjs exports
`inspectVideo(file)` => `{duration,width,height,url,hasVideo:true}` using actual browser metadata.
`renderBrowserClip(file,clip,{format='landscape',onProgress=()=>{},signal})` => `{blob,mimeType,extension,duration,requestedDuration,validation,width,height}` from actual canvas + MediaRecorder. `duration` is measured metadata duration or null, never an assumed measurement; progress is 0–100. Available formats landscape (1280x720), portrait (720x1280), square (720x720). Real-time recording, padded aspect ratio; supported-browser errors explicit. Never call AI generation or gate passed from this routine. Reject empty/invalid/out-of-range output. Abort stops recording safely.

## UI pages
Overview, Studio (upload video + SRT, generate plans, real browser export, backend upload/queue), Quality (check gates), Campaigns (local plans + CSV report import + budget recommendations), Insights (from actual imported data only), Product Lines (three products with live status), Settings (backend URL, API token, test health, export/import workspace, clear local data). Include clear local workspace label, empty states and optional explicitly labeled example. Data persist in localStorage except video bytes (video inputs do not persist). Links to downloadable runtime package at `/downloads/BXAGI_Video_MVP.zip`. Use content escaping; do not render uploaded text as trusted HTML.

## Backend HTTP
Header `Authorization: Bearer <BX_API_TOKEN>` when configured; UI credentials stored in sessionStorage only, not workspace export. GET /api/health optionally public, no secrets.
- POST /api/assets raw video bytes, header X-Filename. Returns `{id,name,duration,width,height,...}`.
- GET /api/assets returns `{assets:[]}`.
- POST /api/assets/:id/transcript JSON `{srt}` => `{segments:[]}`.
- POST /api/assets/:id/plan JSON `{count,min_duration,max_duration,strategy,use_ai:false}` => `{clips:[],engine}`.
- Explicit `use_ai:true` invokes the configured compatible model, validates returned SRT ranges and retains returned token usage. No credentials means 503, never a fabricated result.
- POST /api/assets/:id/transcribe JSON `{engine:'local'}` uses installed faster-whisper plus existing local weights. No installation or weights means 503; no implicit model downloads.
- POST /api/jobs JSON `{asset_id,title,clips:[{start,end}],format:'landscape',burn_subtitles:false}` => `{id,status:'queued'}`.
- GET /api/jobs => `{jobs:[]}`; GET /api/jobs/:id => detail, gates and output_url only for passed output.
- GET /api/jobs/:id/download => MP4 only for passed job; authorization required if token enabled.
- GET /api/audit => `{events:[]}`.
- POST /api/campaigns => locally persisted plan only.
- GET /api/campaigns => `{campaigns:[]}`.
- POST /api/campaigns/:id/metrics JSON `{spend,revenue,conversions,has_conversion,data_fresh}` => stored data plus recommendation.
- GET /api/capabilities => honest implementation/integration status.
Health reports `llm_configured` and `asr_configured`; those flag configuration, not prior successful real inference.
Do not send ad requests; integrations are not configured. Optional compatible model endpoint ONLY when env and explicit use_ai true, no fabricated model output.

## Common safeguards
No secrets in source, outputs, sample config or audits. No paid spend without actual user-selected external integration. Persist job failures and restart recovery; media decode and sentence gate failures fail closed. Local draft export can be unverified and must be labeled. Real FFmpeg output must have both checks before official download. Missing dependencies give an actionable error.
